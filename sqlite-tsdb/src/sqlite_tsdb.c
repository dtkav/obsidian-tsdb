#include "sqlite_tsdb.h"
#include "tsdb_codec.h"

#include <math.h>
#include <errno.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <sqlite3ext.h>
#ifndef SQLITE_CORE
SQLITE_EXTENSION_INIT1
#endif

#define TSDB_DEFAULT_BLOCK_SPAN_MS 21600000LL
#define TSDB_DEFAULT_MAX_BLOCK_POINTS 2048
#define TSDB_MAX_QUERY_POINTS 10000000

#define PLAN_SERIES_EQ 0x0001
#define PLAN_TS_EQ 0x0002
#define PLAN_TS_GT 0x0004
#define PLAN_TS_GE 0x0008
#define PLAN_TS_LT 0x0010
#define PLAN_TS_LE 0x0020

typedef struct TsdbVtab {
    sqlite3_vtab base;
    sqlite3 *db;
    char *name;
    char *head_name;
    char *blocks_name;
    sqlite3_int64 block_span_ms;
    int max_block_points;
    sqlite3_stmt *insert_head_statement;
} TsdbVtab;

typedef struct TsdbRow {
    sqlite3_int64 series_id;
    sqlite3_int64 timestamp_ms;
    uint64_t value_bits;
    unsigned char hot;
} TsdbRow;

typedef struct TsdbCursor {
    sqlite3_vtab_cursor base;
    TsdbRow *rows;
    int row_count;
    int row_index;
} TsdbCursor;

typedef struct TsdbBucket {
    sqlite3_int64 series_id;
    sqlite3_int64 bucket_start_ms;
} TsdbBucket;

typedef struct TsdbBatchVtab {
    sqlite3_vtab base;
} TsdbBatchVtab;

typedef struct TsdbBatchCursor {
    sqlite3_vtab_cursor base;
    unsigned char *data;
    uint32_t record_count;
    uint32_t record_index;
} TsdbBatchCursor;

typedef struct TsdbPackState {
    TsdbCodecPoint *points;
    uint32_t count;
    uint32_t capacity;
    int error_code;
} TsdbPackState;

static int tsdb_disconnect(sqlite3_vtab *vtab);

static sqlite3_int64 bits_to_sql_int(uint64_t bits) {
    sqlite3_int64 value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

static uint64_t sql_int_to_bits(sqlite3_int64 value) {
    uint64_t bits;
    memcpy(&bits, &value, sizeof(bits));
    return bits;
}

static uint16_t read_u16(const unsigned char *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t read_u32(const unsigned char *p) {
    return (uint32_t)p[0] |
           ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static uint64_t read_u64(const unsigned char *p) {
    uint64_t value = 0;
    int i;
    for (i = 7; i >= 0; --i) value = (value << 8) | p[i];
    return value;
}

static void set_vtab_error(TsdbVtab *vtab, const char *format, ...) {
    va_list args;
    sqlite3_free(vtab->base.zErrMsg);
    va_start(args, format);
    vtab->base.zErrMsg = sqlite3_vmprintf(format, args);
    va_end(args);
}

static int exec_format(sqlite3 *db, char **error_message, const char *format, ...) {
    va_list args;
    char *sql;
    int rc;
    va_start(args, format);
    sql = sqlite3_vmprintf(format, args);
    va_end(args);
    if (!sql) return SQLITE_NOMEM;
    rc = sqlite3_exec(db, sql, NULL, NULL, error_message);
    sqlite3_free(sql);
    return rc;
}

static int prepare_format(
    sqlite3 *db,
    sqlite3_stmt **statement,
    const char *format,
    ...) {
    va_list args;
    char *sql;
    int rc;
    va_start(args, format);
    sql = sqlite3_vmprintf(format, args);
    va_end(args);
    if (!sql) return SQLITE_NOMEM;
    rc = sqlite3_prepare_v2(db, sql, -1, statement, NULL);
    sqlite3_free(sql);
    return rc;
}

static int parse_positive_i64(
    const char *argument,
    const char *prefix,
    sqlite3_int64 *value) {
    size_t prefix_length = strlen(prefix);
    char *end = NULL;
    long long parsed;
    if (strncmp(argument, prefix, prefix_length) != 0) return 0;
    errno = 0;
    parsed = strtoll(argument + prefix_length, &end, 10);
    if (!end || *end != '\0' || parsed <= 0 || errno == ERANGE) return -1;
    *value = (sqlite3_int64)parsed;
    return 1;
}

static int allocate_vtab(
    sqlite3 *db,
    int argc,
    const char *const *argv,
    TsdbVtab **result,
    char **error_message) {
    TsdbVtab *vtab;
    int i;
    sqlite3_int64 parsed;

    vtab = (TsdbVtab *)sqlite3_malloc64(sizeof(*vtab));
    if (!vtab) return SQLITE_NOMEM;
    memset(vtab, 0, sizeof(*vtab));
    vtab->db = db;
    vtab->block_span_ms = TSDB_DEFAULT_BLOCK_SPAN_MS;
    vtab->max_block_points = TSDB_DEFAULT_MAX_BLOCK_POINTS;
    vtab->name = sqlite3_mprintf("%s", argv[2]);
    vtab->head_name = sqlite3_mprintf("%s_head", argv[2]);
    vtab->blocks_name = sqlite3_mprintf("%s_blocks", argv[2]);
    if (!vtab->name || !vtab->head_name || !vtab->blocks_name) {
        tsdb_disconnect(&vtab->base);
        return SQLITE_NOMEM;
    }

    for (i = 3; i < argc; ++i) {
        int match = parse_positive_i64(argv[i], "block_span_ms=", &parsed);
        if (match < 0) {
            *error_message = sqlite3_mprintf("invalid tsdb argument: %s", argv[i]);
            tsdb_disconnect(&vtab->base);
            return SQLITE_ERROR;
        }
        if (match > 0) {
            vtab->block_span_ms = parsed;
            continue;
        }
        match = parse_positive_i64(argv[i], "max_block_points=", &parsed);
        if (match < 0 || (match > 0 && parsed > TSDB_BLOCK_MAX_POINTS)) {
            *error_message = sqlite3_mprintf("invalid tsdb argument: %s", argv[i]);
            tsdb_disconnect(&vtab->base);
            return SQLITE_ERROR;
        }
        if (match > 0) {
            vtab->max_block_points = (int)parsed;
            continue;
        }
        *error_message = sqlite3_mprintf("unknown tsdb argument: %s", argv[i]);
        tsdb_disconnect(&vtab->base);
        return SQLITE_ERROR;
    }

    *result = vtab;
    return SQLITE_OK;
}

static int declare_vtab(sqlite3 *db) {
    int rc = sqlite3_declare_vtab(
        db,
        "CREATE TABLE x("
        "series_id INTEGER NOT NULL,"
        "ts INTEGER NOT NULL,"
        "value REAL NOT NULL,"
        "control TEXT HIDDEN,"
        "arg1 INTEGER HIDDEN,"
        "arg2 INTEGER HIDDEN)"
    );
    if (rc == SQLITE_OK) {
        rc = sqlite3_vtab_config(db, SQLITE_VTAB_CONSTRAINT_SUPPORT, 1);
    }
    return rc;
}

static int tsdb_create(
    sqlite3 *db,
    void *aux,
    int argc,
    const char *const *argv,
    sqlite3_vtab **result,
    char **error_message) {
    TsdbVtab *vtab = NULL;
    char *sql_error = NULL;
    int rc;
    (void)aux;

    rc = allocate_vtab(db, argc, argv, &vtab, error_message);
    if (rc != SQLITE_OK) return rc;
    rc = exec_format(
        db,
        &sql_error,
        "CREATE TABLE \"%w\"("
        "series_id INTEGER NOT NULL,"
        "ts INTEGER NOT NULL,"
        "value_bits INTEGER NOT NULL,"
        "PRIMARY KEY(series_id, ts)) WITHOUT ROWID;"
        "CREATE INDEX \"%w_ts\" ON \"%w\"(ts, series_id);"
        "CREATE TABLE \"%w\"("
        "series_id INTEGER NOT NULL,"
        "bucket_start_ms INTEGER NOT NULL,"
        "chunk_no INTEGER NOT NULL,"
        "min_ts INTEGER NOT NULL,"
        "max_ts INTEGER NOT NULL,"
        "sample_count INTEGER NOT NULL,"
        "codec INTEGER NOT NULL,"
        "payload BLOB NOT NULL,"
        "PRIMARY KEY(series_id, bucket_start_ms, chunk_no)) WITHOUT ROWID;"
        "CREATE INDEX \"%w_end\" ON \"%w\"(max_ts, series_id);",
        vtab->head_name,
        vtab->head_name,
        vtab->head_name,
        vtab->blocks_name,
        vtab->blocks_name,
        vtab->blocks_name);
    if (rc != SQLITE_OK) {
        *error_message = sql_error ? sql_error : sqlite3_mprintf("shadow schema failed");
        tsdb_disconnect(&vtab->base);
        return rc;
    }
    rc = declare_vtab(db);
    if (rc != SQLITE_OK) {
        tsdb_disconnect(&vtab->base);
        return rc;
    }
    *result = &vtab->base;
    return SQLITE_OK;
}

static int tsdb_connect(
    sqlite3 *db,
    void *aux,
    int argc,
    const char *const *argv,
    sqlite3_vtab **result,
    char **error_message) {
    TsdbVtab *vtab = NULL;
    int rc;
    (void)aux;
    rc = allocate_vtab(db, argc, argv, &vtab, error_message);
    if (rc != SQLITE_OK) return rc;
    rc = declare_vtab(db);
    if (rc != SQLITE_OK) {
        tsdb_disconnect(&vtab->base);
        return rc;
    }
    *result = &vtab->base;
    return SQLITE_OK;
}

static int tsdb_best_index(sqlite3_vtab *base, sqlite3_index_info *info) {
    int series = -1;
    int ts_eq = -1;
    int ts_gt = -1;
    int ts_ge = -1;
    int ts_lt = -1;
    int ts_le = -1;
    int argument = 1;
    int i;
    (void)base;

    for (i = 0; i < info->nConstraint; ++i) {
        const struct sqlite3_index_constraint *constraint = &info->aConstraint[i];
        if (!constraint->usable) continue;
        if (constraint->iColumn == 0 &&
            constraint->op == SQLITE_INDEX_CONSTRAINT_EQ && series < 0) {
            series = i;
        } else if (constraint->iColumn == 1) {
            switch (constraint->op) {
                case SQLITE_INDEX_CONSTRAINT_EQ:
                    if (ts_eq < 0) ts_eq = i;
                    break;
                case SQLITE_INDEX_CONSTRAINT_GT:
                    if (ts_gt < 0) ts_gt = i;
                    break;
                case SQLITE_INDEX_CONSTRAINT_GE:
                    if (ts_ge < 0) ts_ge = i;
                    break;
                case SQLITE_INDEX_CONSTRAINT_LT:
                    if (ts_lt < 0) ts_lt = i;
                    break;
                case SQLITE_INDEX_CONSTRAINT_LE:
                    if (ts_le < 0) ts_le = i;
                    break;
            }
        }
    }

#define USE_CONSTRAINT(index, flag)                                      \
    do {                                                                  \
        if ((index) >= 0) {                                               \
            info->aConstraintUsage[(index)].argvIndex = argument++;       \
            info->aConstraintUsage[(index)].omit = 1;                     \
            info->idxNum |= (flag);                                       \
        }                                                                 \
    } while (0)

    USE_CONSTRAINT(series, PLAN_SERIES_EQ);
    if (ts_eq >= 0) {
        USE_CONSTRAINT(ts_eq, PLAN_TS_EQ);
    } else {
        if (ts_gt >= 0) {
            USE_CONSTRAINT(ts_gt, PLAN_TS_GT);
        } else {
            USE_CONSTRAINT(ts_ge, PLAN_TS_GE);
        }
        if (ts_lt >= 0) {
            USE_CONSTRAINT(ts_lt, PLAN_TS_LT);
        } else {
            USE_CONSTRAINT(ts_le, PLAN_TS_LE);
        }
    }
#undef USE_CONSTRAINT

    if (info->idxNum & PLAN_SERIES_EQ) {
        info->estimatedCost =
            info->idxNum & (PLAN_TS_EQ | PLAN_TS_GT | PLAN_TS_GE |
                            PLAN_TS_LT | PLAN_TS_LE)
                ? 100.0
                : 10000.0;
        info->estimatedRows = 1000;
    } else {
        info->estimatedCost = 1000000000.0;
        info->estimatedRows = 1000000;
    }
    return SQLITE_OK;
}

static int tsdb_disconnect(sqlite3_vtab *base) {
    TsdbVtab *vtab = (TsdbVtab *)base;
    if (!vtab) return SQLITE_OK;
    sqlite3_free(vtab->name);
    sqlite3_free(vtab->head_name);
    sqlite3_free(vtab->blocks_name);
    sqlite3_finalize(vtab->insert_head_statement);
    sqlite3_free(vtab->base.zErrMsg);
    sqlite3_free(vtab);
    return SQLITE_OK;
}

static int tsdb_destroy(sqlite3_vtab *base) {
    TsdbVtab *vtab = (TsdbVtab *)base;
    char *error_message = NULL;
    int rc;
    sqlite3_finalize(vtab->insert_head_statement);
    vtab->insert_head_statement = NULL;
    rc = exec_format(
        vtab->db,
        &error_message,
        "DROP TABLE IF EXISTS \"%w\";"
        "DROP TABLE IF EXISTS \"%w\";",
        vtab->head_name,
        vtab->blocks_name);
    if (rc != SQLITE_OK) {
        set_vtab_error(vtab, "%s", error_message ? error_message : "drop failed");
    }
    sqlite3_free(error_message);
    tsdb_disconnect(base);
    return rc;
}

static int tsdb_open(sqlite3_vtab *base, sqlite3_vtab_cursor **result) {
    TsdbCursor *cursor = (TsdbCursor *)sqlite3_malloc64(sizeof(*cursor));
    (void)base;
    if (!cursor) return SQLITE_NOMEM;
    memset(cursor, 0, sizeof(*cursor));
    *result = &cursor->base;
    return SQLITE_OK;
}

static int tsdb_close(sqlite3_vtab_cursor *base) {
    TsdbCursor *cursor = (TsdbCursor *)base;
    sqlite3_free(cursor->rows);
    sqlite3_free(cursor);
    return SQLITE_OK;
}

static int append_row(
    TsdbRow **rows,
    int *count,
    int *capacity,
    sqlite3_int64 series_id,
    sqlite3_int64 timestamp_ms,
    uint64_t value_bits,
    int hot) {
    TsdbRow *grown;
    int next_capacity;
    if (*count >= TSDB_MAX_QUERY_POINTS) return SQLITE_TOOBIG;
    if (*count == *capacity) {
        next_capacity = *capacity == 0 ? 256 : *capacity * 2;
        if (next_capacity > TSDB_MAX_QUERY_POINTS) {
            next_capacity = TSDB_MAX_QUERY_POINTS;
        }
        grown = (TsdbRow *)sqlite3_realloc64(
            *rows,
            (sqlite3_uint64)next_capacity * sizeof(**rows));
        if (!grown) return SQLITE_NOMEM;
        *rows = grown;
        *capacity = next_capacity;
    }
    (*rows)[*count].series_id = series_id;
    (*rows)[*count].timestamp_ms = timestamp_ms;
    (*rows)[*count].value_bits = value_bits;
    (*rows)[*count].hot = (unsigned char)(hot != 0);
    ++*count;
    return SQLITE_OK;
}

static int row_compare(const void *left_pointer, const void *right_pointer) {
    const TsdbRow *left = (const TsdbRow *)left_pointer;
    const TsdbRow *right = (const TsdbRow *)right_pointer;
    if (left->series_id < right->series_id) return -1;
    if (left->series_id > right->series_id) return 1;
    if (left->timestamp_ms < right->timestamp_ms) return -1;
    if (left->timestamp_ms > right->timestamp_ms) return 1;
    return (int)left->hot - (int)right->hot;
}

static int sort_and_deduplicate(TsdbRow *rows, int count) {
    int read_index = 0;
    int write_index = 0;
    if (count <= 1) return count;
    qsort(rows, (size_t)count, sizeof(*rows), row_compare);
    while (read_index < count) {
        int next = read_index + 1;
        while (next < count &&
               rows[next].series_id == rows[read_index].series_id &&
               rows[next].timestamp_ms == rows[read_index].timestamp_ms) {
            ++next;
        }
        rows[write_index++] = rows[next - 1];
        read_index = next;
    }
    return write_index;
}

static int load_one_series(
    TsdbVtab *vtab,
    sqlite3_int64 series_id,
    sqlite3_int64 lower,
    sqlite3_int64 upper,
    TsdbRow **rows,
    int *row_count) {
    sqlite3_stmt *statement = NULL;
    TsdbRow *cold = NULL;
    TsdbRow *hot = NULL;
    TsdbRow *merged = NULL;
    int cold_count = 0;
    int cold_capacity = 0;
    int hot_count = 0;
    int hot_capacity = 0;
    int cold_index = 0;
    int hot_index = 0;
    int merged_count = 0;
    int rc;

    rc = prepare_format(
        vtab->db,
        &statement,
        "SELECT payload FROM \"%w\" "
        "WHERE series_id=?1 AND min_ts<=?2 AND max_ts>=?3 "
        "ORDER BY bucket_start_ms,chunk_no",
        vtab->blocks_name);
    if (rc != SQLITE_OK) goto done;
    sqlite3_bind_int64(statement, 1, series_id);
    sqlite3_bind_int64(statement, 2, upper);
    sqlite3_bind_int64(statement, 3, lower);
    while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
        const void *payload = sqlite3_column_blob(statement, 0);
        int payload_size = sqlite3_column_bytes(statement, 0);
        TsdbCodecPoint *decoded = NULL;
        uint32_t decoded_count = 0;
        int codec = 0;
        uint32_t i;
        int codec_rc = tsdb_block_decode(
            payload,
            (size_t)payload_size,
            &decoded,
            &decoded_count,
            &codec);
        (void)codec;
        if (codec_rc != TSDB_CODEC_OK ||
            decoded_count > (uint32_t)vtab->max_block_points) {
            free(decoded);
            rc = SQLITE_CORRUPT_VTAB;
            break;
        }
        rc = SQLITE_OK;
        for (i = 0; i < decoded_count; ++i) {
            if (decoded[i].timestamp_ms < lower ||
                decoded[i].timestamp_ms > upper) {
                continue;
            }
            rc = append_row(
                &cold,
                &cold_count,
                &cold_capacity,
                series_id,
                decoded[i].timestamp_ms,
                decoded[i].value_bits,
                0);
            if (rc != SQLITE_OK) break;
        }
        free(decoded);
        if (rc != SQLITE_OK) break;
    }
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    sqlite3_finalize(statement);
    statement = NULL;
    if (rc != SQLITE_OK) goto done;

    rc = prepare_format(
        vtab->db,
        &statement,
        "SELECT ts,value_bits FROM \"%w\" "
        "WHERE series_id=?1 AND ts>=?2 AND ts<=?3 ORDER BY ts",
        vtab->head_name);
    if (rc != SQLITE_OK) goto done;
    sqlite3_bind_int64(statement, 1, series_id);
    sqlite3_bind_int64(statement, 2, lower);
    sqlite3_bind_int64(statement, 3, upper);
    while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
        rc = append_row(
            &hot,
            &hot_count,
            &hot_capacity,
            series_id,
            sqlite3_column_int64(statement, 0),
            sql_int_to_bits(sqlite3_column_int64(statement, 1)),
            1);
        if (rc != SQLITE_OK) break;
    }
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    sqlite3_finalize(statement);
    statement = NULL;
    if (rc != SQLITE_OK) goto done;
    if (cold_count > TSDB_MAX_QUERY_POINTS - hot_count) {
        rc = SQLITE_TOOBIG;
        goto done;
    }
    if (cold_count + hot_count > 0) {
        merged = (TsdbRow *)sqlite3_malloc64(
            (sqlite3_uint64)(cold_count + hot_count) * sizeof(*merged));
        if (!merged) {
            rc = SQLITE_NOMEM;
            goto done;
        }
    }
    while (cold_index < cold_count || hot_index < hot_count) {
        if (hot_index >= hot_count ||
            (cold_index < cold_count &&
             cold[cold_index].timestamp_ms < hot[hot_index].timestamp_ms)) {
            merged[merged_count++] = cold[cold_index++];
        } else if (cold_index >= cold_count ||
                   hot[hot_index].timestamp_ms < cold[cold_index].timestamp_ms) {
            merged[merged_count++] = hot[hot_index++];
        } else {
            merged[merged_count++] = hot[hot_index++];
            ++cold_index;
        }
    }
    *rows = merged;
    *row_count = merged_count;
    merged = NULL;

done:
    sqlite3_finalize(statement);
    sqlite3_free(cold);
    sqlite3_free(hot);
    sqlite3_free(merged);
    return rc;
}

static int load_rows(
    TsdbVtab *vtab,
    int has_series,
    sqlite3_int64 series_id,
    sqlite3_int64 lower,
    sqlite3_int64 upper,
    TsdbRow **rows,
    int *row_count) {
    sqlite3_stmt *statement = NULL;
    int capacity = 0;
    int count = 0;
    int rc;

    if (has_series) {
        return load_one_series(
            vtab,
            series_id,
            lower,
            upper,
            rows,
            row_count);
    }

    rc = prepare_format(
        vtab->db,
        &statement,
        "SELECT series_id, ts, value_bits FROM \"%w\" "
        "WHERE ts>=?1 AND ts<=?2",
        vtab->head_name);
    if (rc != SQLITE_OK) return rc;
    sqlite3_bind_int64(statement, 1, lower);
    sqlite3_bind_int64(statement, 2, upper);
    while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
        rc = append_row(
            rows,
            &count,
            &capacity,
            sqlite3_column_int64(statement, 0),
            sqlite3_column_int64(statement, 1),
            sql_int_to_bits(sqlite3_column_int64(statement, 2)),
            1);
        if (rc != SQLITE_OK) break;
    }
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    sqlite3_finalize(statement);
    if (rc != SQLITE_OK) {
        sqlite3_free(*rows);
        *rows = NULL;
        return rc;
    }

    statement = NULL;
    rc = prepare_format(
        vtab->db,
        &statement,
        "SELECT series_id, payload FROM \"%w\" "
        "WHERE min_ts<=?1 AND max_ts>=?2",
        vtab->blocks_name);
    if (rc != SQLITE_OK) goto fail;
    sqlite3_bind_int64(statement, 1, upper);
    sqlite3_bind_int64(statement, 2, lower);
    while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
        sqlite3_int64 block_series = sqlite3_column_int64(statement, 0);
        const void *payload = sqlite3_column_blob(statement, 1);
        int payload_size = sqlite3_column_bytes(statement, 1);
        TsdbCodecPoint *decoded = NULL;
        uint32_t decoded_count = 0;
        int codec = 0;
        uint32_t i;
        int codec_rc = tsdb_block_decode(
            payload,
            (size_t)payload_size,
            &decoded,
            &decoded_count,
            &codec);
        (void)codec;
        if (codec_rc != TSDB_CODEC_OK ||
            decoded_count > (uint32_t)vtab->max_block_points) {
            free(decoded);
            rc = SQLITE_CORRUPT_VTAB;
            break;
        }
        rc = SQLITE_OK;
        for (i = 0; i < decoded_count; ++i) {
            if (decoded[i].timestamp_ms < lower ||
                decoded[i].timestamp_ms > upper) {
                continue;
            }
            rc = append_row(
                rows,
                &count,
                &capacity,
                block_series,
                decoded[i].timestamp_ms,
                decoded[i].value_bits,
                0);
            if (rc != SQLITE_OK) break;
        }
        free(decoded);
        if (rc != SQLITE_OK) break;
    }
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    sqlite3_finalize(statement);
    if (rc != SQLITE_OK) goto fail_no_statement;
    count = sort_and_deduplicate(*rows, count);
    *row_count = count;
    return SQLITE_OK;

fail:
    sqlite3_finalize(statement);
fail_no_statement:
    sqlite3_free(*rows);
    *rows = NULL;
    return rc;
}

static int tsdb_filter(
    sqlite3_vtab_cursor *base,
    int plan,
    const char *plan_string,
    int argc,
    sqlite3_value **argv) {
    TsdbCursor *cursor = (TsdbCursor *)base;
    TsdbVtab *vtab = (TsdbVtab *)base->pVtab;
    sqlite3_int64 series_id = 0;
    sqlite3_int64 lower = 0;
    sqlite3_int64 upper = INT64_MAX;
    int has_series = 0;
    int argument = 0;
    int rc;
    (void)plan_string;
    (void)argc;

    sqlite3_free(cursor->rows);
    cursor->rows = NULL;
    cursor->row_count = 0;
    cursor->row_index = 0;

    if (plan & PLAN_SERIES_EQ) {
        has_series = 1;
        series_id = sqlite3_value_int64(argv[argument++]);
    }
    if (plan & PLAN_TS_EQ) {
        lower = upper = sqlite3_value_int64(argv[argument++]);
    } else {
        if (plan & PLAN_TS_GT) {
            lower = sqlite3_value_int64(argv[argument++]);
            if (lower == INT64_MAX) return SQLITE_OK;
            ++lower;
        } else if (plan & PLAN_TS_GE) {
            lower = sqlite3_value_int64(argv[argument++]);
        }
        if (plan & PLAN_TS_LT) {
            upper = sqlite3_value_int64(argv[argument++]);
            if (upper == INT64_MIN) return SQLITE_OK;
            --upper;
        } else if (plan & PLAN_TS_LE) {
            upper = sqlite3_value_int64(argv[argument++]);
        }
    }
    if (upper < lower) return SQLITE_OK;
    rc = load_rows(
        vtab,
        has_series,
        series_id,
        lower,
        upper,
        &cursor->rows,
        &cursor->row_count);
    if (rc == SQLITE_CORRUPT_VTAB) {
        set_vtab_error(vtab, "corrupt sqlite-tsdb block");
    }
    return rc;
}

static int tsdb_next(sqlite3_vtab_cursor *base) {
    TsdbCursor *cursor = (TsdbCursor *)base;
    ++cursor->row_index;
    return SQLITE_OK;
}

static int tsdb_eof(sqlite3_vtab_cursor *base) {
    TsdbCursor *cursor = (TsdbCursor *)base;
    return cursor->row_index >= cursor->row_count;
}

static int tsdb_column(sqlite3_vtab_cursor *base, sqlite3_context *context, int column) {
    TsdbCursor *cursor = (TsdbCursor *)base;
    const TsdbRow *row = &cursor->rows[cursor->row_index];
    switch (column) {
        case 0:
            sqlite3_result_int64(context, row->series_id);
            break;
        case 1:
            sqlite3_result_int64(context, row->timestamp_ms);
            break;
        case 2:
            sqlite3_result_double(context, tsdb_bits_to_double(row->value_bits));
            break;
        default:
            sqlite3_result_null(context);
            break;
    }
    return SQLITE_OK;
}

static int tsdb_rowid(sqlite3_vtab_cursor *base, sqlite3_int64 *rowid) {
    TsdbCursor *cursor = (TsdbCursor *)base;
    *rowid = (sqlite3_int64)cursor->row_index + 1;
    return SQLITE_OK;
}

static int load_bucket(
    TsdbVtab *vtab,
    sqlite3_int64 series_id,
    sqlite3_int64 bucket_start,
    TsdbRow **rows,
    int *row_count) {
    sqlite3_int64 bucket_end;
    if (bucket_start > INT64_MAX - vtab->block_span_ms) return SQLITE_RANGE;
    bucket_end = bucket_start + vtab->block_span_ms - 1;
    return load_rows(
        vtab,
        1,
        series_id,
        bucket_start,
        bucket_end,
        rows,
        row_count);
}

static int delete_bucket_head(
    TsdbVtab *vtab,
    sqlite3_int64 series_id,
    sqlite3_int64 bucket_start) {
    sqlite3_stmt *statement = NULL;
    int rc = prepare_format(
        vtab->db,
        &statement,
        "DELETE FROM \"%w\" WHERE series_id=?1 AND ts>=?2 AND ts<?3",
        vtab->head_name);
    if (rc != SQLITE_OK) return rc;
    sqlite3_bind_int64(statement, 1, series_id);
    sqlite3_bind_int64(statement, 2, bucket_start);
    sqlite3_bind_int64(statement, 3, bucket_start + vtab->block_span_ms);
    rc = sqlite3_step(statement);
    sqlite3_finalize(statement);
    return rc == SQLITE_DONE ? SQLITE_OK : rc;
}

static int write_bucket_blocks(
    TsdbVtab *vtab,
    sqlite3_int64 series_id,
    sqlite3_int64 bucket_start,
    const TsdbRow *rows,
    int row_count) {
    sqlite3_stmt *delete_statement = NULL;
    sqlite3_stmt *insert_statement = NULL;
    int rc;
    int offset;
    int chunk_no = 0;

    rc = prepare_format(
        vtab->db,
        &delete_statement,
        "DELETE FROM \"%w\" WHERE series_id=?1 AND bucket_start_ms=?2",
        vtab->blocks_name);
    if (rc != SQLITE_OK) return rc;
    sqlite3_bind_int64(delete_statement, 1, series_id);
    sqlite3_bind_int64(delete_statement, 2, bucket_start);
    rc = sqlite3_step(delete_statement);
    sqlite3_finalize(delete_statement);
    if (rc != SQLITE_DONE) return rc;
    if (row_count == 0) return SQLITE_OK;

    rc = prepare_format(
        vtab->db,
        &insert_statement,
        "INSERT INTO \"%w\"(series_id,bucket_start_ms,chunk_no,min_ts,max_ts,"
        "sample_count,codec,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        vtab->blocks_name);
    if (rc != SQLITE_OK) return rc;

    for (offset = 0; offset < row_count; offset += vtab->max_block_points) {
        int count = row_count - offset;
        TsdbCodecPoint *points;
        unsigned char *payload = NULL;
        size_t payload_size = 0;
        int codec = 0;
        int codec_rc;
        int i;
        if (count > vtab->max_block_points) count = vtab->max_block_points;
        points = (TsdbCodecPoint *)malloc((size_t)count * sizeof(*points));
        if (!points) {
            rc = SQLITE_NOMEM;
            break;
        }
        for (i = 0; i < count; ++i) {
            points[i].timestamp_ms = rows[offset + i].timestamp_ms;
            points[i].value_bits = rows[offset + i].value_bits;
        }
        codec_rc = tsdb_block_encode(
            points,
            (uint32_t)count,
            &payload,
            &payload_size,
            &codec);
        free(points);
        if (codec_rc != TSDB_CODEC_OK) {
            free(payload);
            rc = codec_rc == TSDB_CODEC_NOMEM ? SQLITE_NOMEM : SQLITE_ERROR;
            break;
        }
        sqlite3_bind_int64(insert_statement, 1, series_id);
        sqlite3_bind_int64(insert_statement, 2, bucket_start);
        sqlite3_bind_int(insert_statement, 3, chunk_no++);
        sqlite3_bind_int64(insert_statement, 4, rows[offset].timestamp_ms);
        sqlite3_bind_int64(
            insert_statement,
            5,
            rows[offset + count - 1].timestamp_ms);
        sqlite3_bind_int(insert_statement, 6, count);
        sqlite3_bind_int(insert_statement, 7, codec);
        sqlite3_bind_blob64(
            insert_statement,
            8,
            payload,
            (sqlite3_uint64)payload_size,
            SQLITE_TRANSIENT);
        rc = sqlite3_step(insert_statement);
        free(payload);
        if (rc != SQLITE_DONE) break;
        sqlite3_reset(insert_statement);
        sqlite3_clear_bindings(insert_statement);
    }
    sqlite3_finalize(insert_statement);
    return rc == SQLITE_DONE ? SQLITE_OK : rc;
}

static int compact_bucket(
    TsdbVtab *vtab,
    sqlite3_int64 series_id,
    sqlite3_int64 bucket_start,
    sqlite3_int64 keep_from) {
    TsdbRow *rows = NULL;
    int row_count = 0;
    int keep_count = 0;
    int i;
    int rc = load_bucket(vtab, series_id, bucket_start, &rows, &row_count);
    if (rc != SQLITE_OK) return rc;
    for (i = 0; i < row_count; ++i) {
        if (rows[i].timestamp_ms >= keep_from) rows[keep_count++] = rows[i];
    }
    rc = write_bucket_blocks(vtab, series_id, bucket_start, rows, keep_count);
    if (rc == SQLITE_OK) rc = delete_bucket_head(vtab, series_id, bucket_start);
    sqlite3_free(rows);
    return rc;
}

static int append_bucket(
    TsdbBucket **buckets,
    int *count,
    int *capacity,
    sqlite3_int64 series_id,
    sqlite3_int64 bucket_start) {
    TsdbBucket *grown;
    int next_capacity;
    if (*count == *capacity) {
        next_capacity = *capacity == 0 ? 16 : *capacity * 2;
        grown = (TsdbBucket *)sqlite3_realloc64(
            *buckets,
            (sqlite3_uint64)next_capacity * sizeof(**buckets));
        if (!grown) return SQLITE_NOMEM;
        *buckets = grown;
        *capacity = next_capacity;
    }
    (*buckets)[*count].series_id = series_id;
    (*buckets)[*count].bucket_start_ms = bucket_start;
    ++*count;
    return SQLITE_OK;
}

static int compact_before(TsdbVtab *vtab, sqlite3_int64 cutoff, int limit) {
    sqlite3_stmt *statement = NULL;
    TsdbBucket *buckets = NULL;
    int bucket_count = 0;
    int capacity = 0;
    int rc;
    int i;
    if (limit <= 0) limit = 16;
    rc = prepare_format(
        vtab->db,
        &statement,
        "SELECT series_id, ts-(ts%%?1) AS bucket_start "
        "FROM \"%w\" "
        "WHERE (ts-(ts%%?1))+?1<=?2 "
        "GROUP BY series_id, bucket_start ORDER BY bucket_start, series_id LIMIT ?3",
        vtab->head_name);
    if (rc != SQLITE_OK) return rc;
    sqlite3_bind_int64(statement, 1, vtab->block_span_ms);
    sqlite3_bind_int64(statement, 2, cutoff);
    sqlite3_bind_int(statement, 3, limit);
    while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
        rc = append_bucket(
            &buckets,
            &bucket_count,
            &capacity,
            sqlite3_column_int64(statement, 0),
            sqlite3_column_int64(statement, 1));
        if (rc != SQLITE_OK) break;
    }
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    sqlite3_finalize(statement);
    if (rc != SQLITE_OK) {
        sqlite3_free(buckets);
        return rc;
    }
    for (i = 0; i < bucket_count; ++i) {
        rc = compact_bucket(
            vtab,
            buckets[i].series_id,
            buckets[i].bucket_start_ms,
            0);
        if (rc != SQLITE_OK) break;
    }
    sqlite3_free(buckets);
    return rc;
}

static int delete_before(TsdbVtab *vtab, sqlite3_int64 cutoff) {
    sqlite3_stmt *statement = NULL;
    TsdbBucket *buckets = NULL;
    int bucket_count = 0;
    int capacity = 0;
    int rc;
    int i;

    rc = prepare_format(
        vtab->db,
        &statement,
        "SELECT DISTINCT series_id, bucket_start_ms FROM \"%w\" "
        "WHERE min_ts<?1 AND max_ts>=?1",
        vtab->blocks_name);
    if (rc != SQLITE_OK) return rc;
    sqlite3_bind_int64(statement, 1, cutoff);
    while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
        rc = append_bucket(
            &buckets,
            &bucket_count,
            &capacity,
            sqlite3_column_int64(statement, 0),
            sqlite3_column_int64(statement, 1));
        if (rc != SQLITE_OK) break;
    }
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    sqlite3_finalize(statement);
    if (rc != SQLITE_OK) goto done;

    rc = prepare_format(
        vtab->db,
        &statement,
        "DELETE FROM \"%w\" WHERE max_ts<?1",
        vtab->blocks_name);
    if (rc != SQLITE_OK) goto done;
    sqlite3_bind_int64(statement, 1, cutoff);
    rc = sqlite3_step(statement);
    sqlite3_finalize(statement);
    statement = NULL;
    if (rc != SQLITE_DONE) goto done;

    for (i = 0; i < bucket_count; ++i) {
        rc = compact_bucket(
            vtab,
            buckets[i].series_id,
            buckets[i].bucket_start_ms,
            cutoff);
        if (rc != SQLITE_OK) goto done;
    }

    rc = prepare_format(
        vtab->db,
        &statement,
        "DELETE FROM \"%w\" WHERE ts<?1",
        vtab->head_name);
    if (rc != SQLITE_OK) goto done;
    sqlite3_bind_int64(statement, 1, cutoff);
    rc = sqlite3_step(statement);
    if (rc == SQLITE_DONE) rc = SQLITE_OK;

done:
    sqlite3_finalize(statement);
    sqlite3_free(buckets);
    return rc;
}

static int insert_sample(
    TsdbVtab *vtab,
    sqlite3_int64 series_id,
    sqlite3_int64 timestamp_ms,
    double value) {
    uint64_t bits = tsdb_double_to_bits(value);
    int rc;
    if (!vtab->insert_head_statement) {
        rc = prepare_format(
            vtab->db,
            &vtab->insert_head_statement,
            "INSERT INTO \"%w\"(series_id,ts,value_bits) VALUES(?1,?2,?3) "
            "ON CONFLICT(series_id,ts) DO UPDATE SET value_bits=excluded.value_bits",
            vtab->head_name);
        if (rc != SQLITE_OK) return rc;
    }
    sqlite3_bind_int64(vtab->insert_head_statement, 1, series_id);
    sqlite3_bind_int64(vtab->insert_head_statement, 2, timestamp_ms);
    sqlite3_bind_int64(
        vtab->insert_head_statement,
        3,
        bits_to_sql_int(bits));
    rc = sqlite3_step(vtab->insert_head_statement);
    sqlite3_reset(vtab->insert_head_statement);
    sqlite3_clear_bindings(vtab->insert_head_statement);
    return rc == SQLITE_DONE ? SQLITE_OK : rc;
}

static int tsdb_update(
    sqlite3_vtab *base,
    int argc,
    sqlite3_value **argv,
    sqlite3_int64 *rowid) {
    TsdbVtab *vtab = (TsdbVtab *)base;
    int rc;
    if (argc == 1) {
        set_vtab_error(vtab, "individual DELETE is not supported; use delete-before");
        return SQLITE_READONLY;
    }
    if (argc < 8) return SQLITE_MISUSE;
    if (sqlite3_value_type(argv[0]) != SQLITE_NULL) {
        set_vtab_error(vtab, "UPDATE is not supported");
        return SQLITE_READONLY;
    }

    if (sqlite3_value_type(argv[5]) != SQLITE_NULL) {
        const char *control = (const char *)sqlite3_value_text(argv[5]);
        if (!control) return SQLITE_NOMEM;
        if (strcmp(control, "compact-before") == 0) {
            if (sqlite3_value_type(argv[6]) != SQLITE_INTEGER) return SQLITE_MISMATCH;
            rc = compact_before(
                vtab,
                sqlite3_value_int64(argv[6]),
                sqlite3_value_type(argv[7]) == SQLITE_INTEGER
                    ? sqlite3_value_int(argv[7])
                    : 16);
        } else if (strcmp(control, "delete-before") == 0) {
            if (sqlite3_value_type(argv[6]) != SQLITE_INTEGER) return SQLITE_MISMATCH;
            rc = delete_before(vtab, sqlite3_value_int64(argv[6]));
        } else {
            set_vtab_error(vtab, "unknown control command: %s", control);
            return SQLITE_ERROR;
        }
        *rowid = 0;
        return rc;
    }

    if (sqlite3_value_type(argv[2]) != SQLITE_INTEGER ||
        sqlite3_value_type(argv[3]) != SQLITE_INTEGER ||
        sqlite3_value_type(argv[4]) == SQLITE_NULL) {
        set_vtab_error(vtab, "series_id, ts, and value are required");
        return SQLITE_MISMATCH;
    }
    if (sqlite3_value_int64(argv[2]) <= 0 ||
        sqlite3_value_int64(argv[3]) < 0 ||
        sqlite3_value_int64(argv[3]) > INT64_MAX - vtab->block_span_ms) {
        set_vtab_error(
            vtab,
            "series_id must be positive and ts must fit a complete block span");
        return SQLITE_CONSTRAINT;
    }
    if (isnan(sqlite3_value_double(argv[4]))) {
        set_vtab_error(vtab, "NaN values are not supported");
        return SQLITE_CONSTRAINT;
    }
    rc = insert_sample(
        vtab,
        sqlite3_value_int64(argv[2]),
        sqlite3_value_int64(argv[3]),
        sqlite3_value_double(argv[4]));
    *rowid = sqlite3_value_int64(argv[3]);
    return rc;
}

static int tsdb_shadow_name(const char *suffix) {
    return sqlite3_stricmp(suffix, "head") == 0 ||
           sqlite3_stricmp(suffix, "blocks") == 0;
}

static int batch_connect(
    sqlite3 *db,
    void *aux,
    int argc,
    const char *const *argv,
    sqlite3_vtab **result,
    char **error_message) {
    TsdbBatchVtab *vtab;
    int rc;
    (void)aux;
    (void)argc;
    (void)argv;
    (void)error_message;
    vtab = (TsdbBatchVtab *)sqlite3_malloc64(sizeof(*vtab));
    if (!vtab) return SQLITE_NOMEM;
    memset(vtab, 0, sizeof(*vtab));
    rc = sqlite3_declare_vtab(
        db,
        "CREATE TABLE x(series_id INTEGER,ts INTEGER,value REAL,batch BLOB HIDDEN)");
    if (rc != SQLITE_OK) {
        sqlite3_free(vtab);
        return rc;
    }
    *result = &vtab->base;
    return SQLITE_OK;
}

static int batch_best_index(sqlite3_vtab *base, sqlite3_index_info *info) {
    int i;
    (void)base;
    for (i = 0; i < info->nConstraint; ++i) {
        if (info->aConstraint[i].usable &&
            info->aConstraint[i].iColumn == 3 &&
            info->aConstraint[i].op == SQLITE_INDEX_CONSTRAINT_EQ) {
            info->aConstraintUsage[i].argvIndex = 1;
            info->aConstraintUsage[i].omit = 1;
            info->idxNum = 1;
            info->estimatedCost = 10.0;
            info->estimatedRows = 1000;
            return SQLITE_OK;
        }
    }
    info->estimatedCost = 1000000000.0;
    return SQLITE_OK;
}

static int batch_disconnect(sqlite3_vtab *base) {
    sqlite3_free(base);
    return SQLITE_OK;
}

static int batch_open(sqlite3_vtab *base, sqlite3_vtab_cursor **result) {
    TsdbBatchCursor *cursor;
    (void)base;
    cursor = (TsdbBatchCursor *)sqlite3_malloc64(sizeof(*cursor));
    if (!cursor) return SQLITE_NOMEM;
    memset(cursor, 0, sizeof(*cursor));
    *result = &cursor->base;
    return SQLITE_OK;
}

static int batch_close(sqlite3_vtab_cursor *base) {
    TsdbBatchCursor *cursor = (TsdbBatchCursor *)base;
    sqlite3_free(cursor->data);
    sqlite3_free(cursor);
    return SQLITE_OK;
}

static int batch_filter(
    sqlite3_vtab_cursor *base,
    int plan,
    const char *plan_string,
    int argc,
    sqlite3_value **argv) {
    TsdbBatchCursor *cursor = (TsdbBatchCursor *)base;
    const unsigned char *input;
    int input_size;
    uint32_t count;
    sqlite3_uint64 expected_size;
    (void)plan_string;
    sqlite3_free(cursor->data);
    cursor->data = NULL;
    cursor->record_count = 0;
    cursor->record_index = 0;
    if (plan != 1 || argc != 1 || sqlite3_value_type(argv[0]) != SQLITE_BLOB) {
        return SQLITE_CONSTRAINT;
    }
    input = (const unsigned char *)sqlite3_value_blob(argv[0]);
    input_size = sqlite3_value_bytes(argv[0]);
    if (!input || input_size < 16 ||
        input[0] != 'T' || input[1] != 'S' || input[2] != 'I' || input[3] != '1' ||
        read_u16(input + 4) != 1 || read_u16(input + 6) != 24 ||
        read_u32(input + 12) != 0) {
        return SQLITE_CORRUPT_VTAB;
    }
    count = read_u32(input + 8);
    if (count > TSDB_MAX_QUERY_POINTS) return SQLITE_TOOBIG;
    expected_size = 16 + (sqlite3_uint64)count * 24;
    if (expected_size != (sqlite3_uint64)input_size) return SQLITE_CORRUPT_VTAB;
    cursor->data = (unsigned char *)sqlite3_malloc64((sqlite3_uint64)input_size);
    if (!cursor->data) return SQLITE_NOMEM;
    memcpy(cursor->data, input, (size_t)input_size);
    cursor->record_count = count;
    return SQLITE_OK;
}

static int batch_next(sqlite3_vtab_cursor *base) {
    TsdbBatchCursor *cursor = (TsdbBatchCursor *)base;
    ++cursor->record_index;
    return SQLITE_OK;
}

static int batch_eof(sqlite3_vtab_cursor *base) {
    TsdbBatchCursor *cursor = (TsdbBatchCursor *)base;
    return cursor->record_index >= cursor->record_count;
}

static int batch_column(
    sqlite3_vtab_cursor *base,
    sqlite3_context *context,
    int column) {
    TsdbBatchCursor *cursor = (TsdbBatchCursor *)base;
    const unsigned char *record = cursor->data + 16 + (size_t)cursor->record_index * 24;
    switch (column) {
        case 0:
            sqlite3_result_int64(context, bits_to_sql_int(read_u64(record)));
            break;
        case 1:
            sqlite3_result_int64(context, bits_to_sql_int(read_u64(record + 8)));
            break;
        case 2:
            sqlite3_result_double(context, tsdb_bits_to_double(read_u64(record + 16)));
            break;
        default:
            sqlite3_result_null(context);
            break;
    }
    return SQLITE_OK;
}

static int batch_rowid(sqlite3_vtab_cursor *base, sqlite3_int64 *rowid) {
    TsdbBatchCursor *cursor = (TsdbBatchCursor *)base;
    *rowid = (sqlite3_int64)cursor->record_index + 1;
    return SQLITE_OK;
}

static int pack_point_compare(const void *left_pointer, const void *right_pointer) {
    const TsdbCodecPoint *left = (const TsdbCodecPoint *)left_pointer;
    const TsdbCodecPoint *right = (const TsdbCodecPoint *)right_pointer;
    if (left->timestamp_ms < right->timestamp_ms) return -1;
    if (left->timestamp_ms > right->timestamp_ms) return 1;
    return 0;
}

static void pack_step(
    sqlite3_context *context,
    int argc,
    sqlite3_value **argv) {
    TsdbPackState *state;
    TsdbCodecPoint *grown;
    uint32_t next_capacity;
    double value;
    (void)argc;
    state = (TsdbPackState *)sqlite3_aggregate_context(context, sizeof(*state));
    if (!state) {
        sqlite3_result_error_nomem(context);
        return;
    }
    if (state->error_code != SQLITE_OK) return;
    if (sqlite3_value_type(argv[0]) != SQLITE_INTEGER ||
        sqlite3_value_type(argv[1]) == SQLITE_NULL) {
        state->error_code = SQLITE_MISMATCH;
        sqlite3_result_error(context, "tsdb_pack requires integer ts and numeric value", -1);
        return;
    }
    value = sqlite3_value_double(argv[1]);
    if (isnan(value)) {
        state->error_code = SQLITE_CONSTRAINT;
        sqlite3_result_error(context, "tsdb_pack does not accept NaN", -1);
        return;
    }
    if (state->count >= TSDB_BLOCK_MAX_POINTS) {
        state->error_code = SQLITE_TOOBIG;
        sqlite3_result_error_toobig(context);
        return;
    }
    if (state->count == state->capacity) {
        next_capacity = state->capacity == 0 ? 256 : state->capacity * 2;
        if (next_capacity > TSDB_BLOCK_MAX_POINTS) {
            next_capacity = TSDB_BLOCK_MAX_POINTS;
        }
        grown = (TsdbCodecPoint *)sqlite3_realloc64(
            state->points,
            (sqlite3_uint64)next_capacity * sizeof(*grown));
        if (!grown) {
            state->error_code = SQLITE_NOMEM;
            sqlite3_result_error_nomem(context);
            return;
        }
        state->points = grown;
        state->capacity = next_capacity;
    }
    state->points[state->count].timestamp_ms = sqlite3_value_int64(argv[0]);
    state->points[state->count].value_bits = tsdb_double_to_bits(value);
    ++state->count;
}

static void pack_final(sqlite3_context *context) {
    TsdbPackState *state = (TsdbPackState *)sqlite3_aggregate_context(context, 0);
    unsigned char *output = NULL;
    size_t output_size = 0;
    int codec = 0;
    int codec_rc;
    uint32_t i;
    if (!state || state->count == 0) {
        sqlite3_result_null(context);
        return;
    }
    if (state->error_code != SQLITE_OK) {
        sqlite3_free(state->points);
        state->points = NULL;
        return;
    }
    qsort(state->points, state->count, sizeof(*state->points), pack_point_compare);
    for (i = 1; i < state->count; ++i) {
        if (state->points[i - 1].timestamp_ms == state->points[i].timestamp_ms) {
            sqlite3_free(state->points);
            state->points = NULL;
            sqlite3_result_error(context, "tsdb_pack timestamps must be unique", -1);
            return;
        }
    }
    codec_rc = tsdb_block_encode(
        state->points,
        state->count,
        &output,
        &output_size,
        &codec);
    (void)codec;
    sqlite3_free(state->points);
    state->points = NULL;
    if (codec_rc != TSDB_CODEC_OK) {
        if (codec_rc == TSDB_CODEC_NOMEM) {
            sqlite3_result_error_nomem(context);
        } else if (codec_rc == TSDB_CODEC_RANGE) {
            sqlite3_result_error_toobig(context);
        } else {
            sqlite3_result_error(context, tsdb_codec_error(codec_rc), -1);
        }
        free(output);
        return;
    }
    sqlite3_result_blob64(context, output, output_size, free);
}

static void version_function(
    sqlite3_context *context,
    int argc,
    sqlite3_value **argv) {
    (void)argc;
    (void)argv;
    sqlite3_result_text(context, SQLITE_TSDB_VERSION, -1, SQLITE_STATIC);
}

static sqlite3_module tsdb_module = {
    3,
    tsdb_create,
    tsdb_connect,
    tsdb_best_index,
    tsdb_disconnect,
    tsdb_destroy,
    tsdb_open,
    tsdb_close,
    tsdb_filter,
    tsdb_next,
    tsdb_eof,
    tsdb_column,
    tsdb_rowid,
    tsdb_update,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    tsdb_shadow_name
};

static sqlite3_module batch_module = {
    1,
    NULL,
    batch_connect,
    batch_best_index,
    batch_disconnect,
    NULL,
    batch_open,
    batch_close,
    batch_filter,
    batch_next,
    batch_eof,
    batch_column,
    batch_rowid,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
};

int sqlite3_tsdb_register(sqlite3 *db) {
    int rc = sqlite3_create_module_v2(db, "tsdb", &tsdb_module, NULL, NULL);
    if (rc != SQLITE_OK) return rc;
    rc = sqlite3_create_module_v2(db, "tsdb_batch", &batch_module, NULL, NULL);
    if (rc != SQLITE_OK) return rc;
    rc = sqlite3_create_function_v2(
        db,
        "tsdb_version",
        0,
        SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
        NULL,
        version_function,
        NULL,
        NULL,
        NULL);
    if (rc != SQLITE_OK) return rc;
    return sqlite3_create_function_v2(
        db,
        "tsdb_pack",
        2,
        SQLITE_UTF8 | SQLITE_INNOCUOUS,
        NULL,
        NULL,
        pack_step,
        pack_final,
        NULL);
}

int sqlite3_sqlitetsdb_init(
    sqlite3 *db,
    char **error_message,
    const sqlite3_api_routines *api) {
    int rc;
    (void)error_message;
#ifndef SQLITE_CORE
    SQLITE_EXTENSION_INIT2(api);
#else
    (void)api;
#endif
    rc = sqlite3_tsdb_register(db);
    return rc;
}

int sqlite3_tsdb_init(
    sqlite3 *db,
    char **error_message,
    const sqlite3_api_routines *api) {
    return sqlite3_sqlitetsdb_init(db, error_message, api);
}
