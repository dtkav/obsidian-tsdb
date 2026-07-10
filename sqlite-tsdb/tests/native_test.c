#include "sqlite_tsdb.h"
#include "tsdb_codec.h"

#include <assert.h>
#include <math.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void put_u16(unsigned char *p, uint16_t value) {
    p[0] = (unsigned char)value;
    p[1] = (unsigned char)(value >> 8);
}

static void put_u32(unsigned char *p, uint32_t value) {
    p[0] = (unsigned char)value;
    p[1] = (unsigned char)(value >> 8);
    p[2] = (unsigned char)(value >> 16);
    p[3] = (unsigned char)(value >> 24);
}

static void put_u64(unsigned char *p, uint64_t value) {
    int i;
    for (i = 0; i < 8; ++i) p[i] = (unsigned char)(value >> (i * 8));
}

static void execute(sqlite3 *db, const char *sql) {
    char *error = NULL;
    int rc = sqlite3_exec(db, sql, NULL, NULL, &error);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "SQL failed (%d): %s\n%s\n", rc, error, sql);
        sqlite3_free(error);
        abort();
    }
}

static sqlite3_int64 scalar_i64(sqlite3 *db, const char *sql) {
    sqlite3_stmt *statement = NULL;
    sqlite3_int64 value;
    assert(sqlite3_prepare_v2(db, sql, -1, &statement, NULL) == SQLITE_OK);
    assert(sqlite3_step(statement) == SQLITE_ROW);
    value = sqlite3_column_int64(statement, 0);
    assert(sqlite3_step(statement) == SQLITE_DONE);
    sqlite3_finalize(statement);
    return value;
}

static void assert_integrity(sqlite3 *db) {
    sqlite3_stmt *statement = NULL;
    const unsigned char *value;
    assert(sqlite3_prepare_v2(
               db,
               "PRAGMA integrity_check",
               -1,
               &statement,
               NULL) == SQLITE_OK);
    assert(sqlite3_step(statement) == SQLITE_ROW);
    value = sqlite3_column_text(statement, 0);
    assert(value != NULL && strcmp((const char *)value, "ok") == 0);
    assert(sqlite3_step(statement) == SQLITE_DONE);
    sqlite3_finalize(statement);
}

static void assert_value(
    sqlite3 *db,
    sqlite3_int64 series_id,
    sqlite3_int64 ts,
    double expected) {
    sqlite3_stmt *statement = NULL;
    double actual;
    assert(sqlite3_prepare_v2(
               db,
               "SELECT value FROM samples WHERE series_id=?1 AND ts=?2",
               -1,
               &statement,
               NULL) == SQLITE_OK);
    sqlite3_bind_int64(statement, 1, series_id);
    sqlite3_bind_int64(statement, 2, ts);
    assert(sqlite3_step(statement) == SQLITE_ROW);
    actual = sqlite3_column_double(statement, 0);
    assert(memcmp(&actual, &expected, sizeof(actual)) == 0);
    assert(sqlite3_step(statement) == SQLITE_DONE);
    sqlite3_finalize(statement);
}

int main(void) {
    sqlite3 *db = NULL;
    sqlite3_stmt *insert = NULL;
    int i;
    unsigned char batch[16 + 3 * 24];
    sqlite3_stmt *batch_insert = NULL;
    sqlite3_stmt *direct_batch_insert = NULL;
    sqlite3_stmt *pack_query = NULL;
    TsdbCodecPoint *packed_points = NULL;
    uint32_t packed_count = 0;
    int packed_codec = 0;

    assert(sqlite3_open(":memory:", &db) == SQLITE_OK);
    assert(sqlite3_tsdb_register(db) == SQLITE_OK);
    assert(strcmp(SQLITE_TSDB_VERSION, "0.1.0-dev") == 0);
    execute(
        db,
        "CREATE VIRTUAL TABLE samples USING tsdb("
        "block_span_ms=1000,max_block_points=4)");
    assert(sqlite3_prepare_v2(
               db,
               "INSERT INTO samples(series_id,ts,value) VALUES(?1,?2,?3)",
               -1,
               &insert,
               NULL) == SQLITE_OK);
    execute(db, "BEGIN");
    for (i = 0; i < 20; ++i) {
        sqlite3_bind_int64(insert, 1, i < 15 ? 1 : 2);
        sqlite3_bind_int64(insert, 2, (sqlite3_int64)i * 100);
        sqlite3_bind_double(insert, 3, i == 3 ? -0.0 : (double)i + 0.25);
        assert(sqlite3_step(insert) == SQLITE_DONE);
        sqlite3_reset(insert);
        sqlite3_clear_bindings(insert);
    }
    execute(db, "COMMIT");
    sqlite3_finalize(insert);
    assert(scalar_i64(db, "SELECT count(*) FROM samples") == 20);

    execute(
        db,
        "INSERT INTO samples(control,arg1,arg2) "
        "VALUES('compact-before',2000,100)");
    assert(scalar_i64(db, "SELECT count(*) FROM samples_head") == 0);
    assert(scalar_i64(db, "SELECT count(*) FROM samples_blocks") > 0);
    assert(scalar_i64(db, "SELECT count(*) FROM samples") == 20);
    assert_value(db, 1, 300, -0.0);

    execute(db, "INSERT INTO samples(series_id,ts,value) VALUES(1,300,99.5)");
    assert_value(db, 1, 300, 99.5);
    execute(
        db,
        "INSERT INTO samples(control,arg1,arg2) "
        "VALUES('compact-before',2000,100)");
    assert_value(db, 1, 300, 99.5);
    assert(scalar_i64(db, "SELECT count(*) FROM samples") == 20);
    assert(scalar_i64(
               db,
               "SELECT count(*) FROM samples WHERE ts BETWEEN 751 AND 799") == 0);
    assert(scalar_i64(
               db,
               "SELECT count(*) FROM samples "
               "WHERE series_id=1 AND ts BETWEEN 751 AND 799") == 0);

    execute(
        db,
        "INSERT INTO samples(control,arg1) VALUES('delete-before',750)");
    assert(scalar_i64(db, "SELECT count(*) FROM samples") == 12);
    assert(scalar_i64(db, "SELECT min(ts) FROM samples") == 800);
    assert_integrity(db);

    memset(batch, 0, sizeof(batch));
    memcpy(batch, "TSI1", 4);
    put_u16(batch + 4, 1);
    put_u16(batch + 6, 24);
    put_u32(batch + 8, 3);
    for (i = 0; i < 3; ++i) {
        double value = i == 1 ? -0.0 : (double)i + 10.5;
        unsigned char *record = batch + 16 + i * 24;
        put_u64(record, 3);
        put_u64(record + 8, (uint64_t)(3000 + i * 100));
        put_u64(record + 16, tsdb_double_to_bits(value));
    }
    assert(sqlite3_prepare_v2(
               db,
               "INSERT INTO samples(series_id,ts,value) "
               "SELECT series_id,ts,value FROM tsdb_batch(?1)",
               -1,
               &batch_insert,
               NULL) == SQLITE_OK);
    sqlite3_bind_blob(batch_insert, 1, batch, sizeof(batch), SQLITE_STATIC);
    assert(sqlite3_step(batch_insert) == SQLITE_DONE);
    sqlite3_finalize(batch_insert);
    assert(scalar_i64(db, "SELECT count(*) FROM samples WHERE series_id=3") == 3);

    put_u64(batch + 16, 3);
    put_u64(batch + 16 + 8, 3000);
    put_u64(batch + 16 + 16, tsdb_double_to_bits(99.5));
    for (i = 1; i < 3; ++i) {
        unsigned char *record = batch + 16 + i * 24;
        put_u64(record, 4);
        put_u64(record + 8, (uint64_t)(3900 + i * 100));
        put_u64(record + 16, tsdb_double_to_bits((double)i + 20.5));
    }
    assert(sqlite3_prepare_v2(
               db,
               "INSERT INTO samples(control,arg1,arg2) "
               "VALUES('ingest-batch',?1,0)",
               -1,
               &direct_batch_insert,
               NULL) == SQLITE_OK);
    sqlite3_bind_blob(direct_batch_insert, 1, batch, sizeof(batch), SQLITE_STATIC);
    assert(sqlite3_step(direct_batch_insert) == SQLITE_DONE);
    sqlite3_finalize(direct_batch_insert);
    direct_batch_insert = NULL;
    assert(scalar_i64(db, "SELECT sum(sample_count) FROM samples_changes") == 2);
    assert_value(db, 3, 3000, 10.5);

    assert(sqlite3_prepare_v2(
               db,
               "INSERT INTO samples(control,arg1,arg2) "
               "VALUES('ingest-batch',?1,1)",
               -1,
               &direct_batch_insert,
               NULL) == SQLITE_OK);
    sqlite3_bind_blob(direct_batch_insert, 1, batch, sizeof(batch), SQLITE_STATIC);
    assert(sqlite3_step(direct_batch_insert) == SQLITE_DONE);
    sqlite3_finalize(direct_batch_insert);
    assert(scalar_i64(db, "SELECT count(*) FROM samples_changes") == 0);
    assert_value(db, 3, 3000, 99.5);

    execute(
        db,
        "INSERT INTO samples(control,arg1,arg2) "
        "VALUES('compact-before',5000,100)");
    put_u64(batch + 16 + 16, tsdb_double_to_bits(77.25));
    assert(sqlite3_prepare_v2(
               db,
               "INSERT INTO samples(control,arg1,arg2) "
               "VALUES('ingest-batch',?1,0)",
               -1,
               &direct_batch_insert,
               NULL) == SQLITE_OK);
    sqlite3_bind_blob(direct_batch_insert, 1, batch, sizeof(batch), SQLITE_STATIC);
    assert(sqlite3_step(direct_batch_insert) == SQLITE_DONE);
    sqlite3_finalize(direct_batch_insert);
    direct_batch_insert = NULL;
    assert(scalar_i64(db, "SELECT count(*) FROM samples_changes") == 0);
    assert_value(db, 3, 3000, 99.5);

    assert(sqlite3_prepare_v2(
               db,
               "INSERT INTO samples(control,arg1,arg2) "
               "VALUES('ingest-batch',?1,1)",
               -1,
               &direct_batch_insert,
               NULL) == SQLITE_OK);
    sqlite3_bind_blob(direct_batch_insert, 1, batch, sizeof(batch), SQLITE_STATIC);
    assert(sqlite3_step(direct_batch_insert) == SQLITE_DONE);
    sqlite3_finalize(direct_batch_insert);
    assert(scalar_i64(db, "SELECT count(*) FROM samples_changes") == 0);
    assert_value(db, 3, 3000, 77.25);

    assert(sqlite3_prepare_v2(
               db,
               "SELECT tsdb_pack(ts,value) FROM samples WHERE series_id=3",
               -1,
               &pack_query,
               NULL) == SQLITE_OK);
    assert(sqlite3_step(pack_query) == SQLITE_ROW);
    assert(tsdb_block_decode(
               sqlite3_column_blob(pack_query, 0),
               (size_t)sqlite3_column_bytes(pack_query, 0),
               &packed_points,
               &packed_count,
               &packed_codec) == TSDB_CODEC_OK);
    assert(packed_count == 3);
    assert(packed_points[1].timestamp_ms == 3100);
    assert(packed_points[1].value_bits == tsdb_double_to_bits(-0.0));
    free(packed_points);
    assert(sqlite3_step(pack_query) == SQLITE_DONE);
    sqlite3_finalize(pack_query);

    execute(db, "DROP TABLE samples");
    assert(sqlite3_close(db) == SQLITE_OK);
    printf("native virtual table tests passed\n");
    return 0;
}
