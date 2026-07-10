#include "tsdb_codec.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define TSDB_MAGIC_0 'S'
#define TSDB_MAGIC_1 'T'
#define TSDB_MAGIC_2 'B'
#define TSDB_MAGIC_3 '1'

static void put_u32(unsigned char *p, uint32_t value) {
    p[0] = (unsigned char)value;
    p[1] = (unsigned char)(value >> 8);
    p[2] = (unsigned char)(value >> 16);
    p[3] = (unsigned char)(value >> 24);
}

static void put_u64(unsigned char *p, uint64_t value) {
    int i;
    for (i = 0; i < 8; ++i) {
        p[i] = (unsigned char)(value >> (i * 8));
    }
}

static uint32_t get_u32(const unsigned char *p) {
    return (uint32_t)p[0] |
           ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static uint64_t get_u64(const unsigned char *p) {
    uint64_t value = 0;
    int i;
    for (i = 7; i >= 0; --i) {
        value = (value << 8) | p[i];
    }
    return value;
}

static int64_t u64_to_i64(uint64_t value) {
    int64_t result;
    memcpy(&result, &value, sizeof(result));
    return result;
}

static size_t uleb_size(uint64_t value) {
    size_t size = 1;
    while (value >= 0x80U) {
        value >>= 7;
        ++size;
    }
    return size;
}

static unsigned char *put_uleb(unsigned char *p, uint64_t value) {
    do {
        unsigned char byte = (unsigned char)(value & 0x7fU);
        value >>= 7;
        if (value != 0) byte |= 0x80U;
        *p++ = byte;
    } while (value != 0);
    return p;
}

static int get_uleb(
    const unsigned char **cursor,
    const unsigned char *end,
    uint64_t *value) {
    uint64_t result = 0;
    unsigned shift = 0;
    const unsigned char *p = *cursor;

    while (p < end && shift < 64) {
        unsigned char byte = *p++;
        uint64_t part = (uint64_t)(byte & 0x7fU);
        if (shift == 63 && part > 1) return TSDB_CODEC_CORRUPT;
        result |= part << shift;
        if ((byte & 0x80U) == 0) {
            *cursor = p;
            *value = result;
            return TSDB_CODEC_OK;
        }
        shift += 7;
    }
    return TSDB_CODEC_CORRUPT;
}

static uint64_t zigzag_encode(int64_t value) {
    return ((uint64_t)value << 1) ^ (uint64_t)-(value < 0);
}

static int64_t zigzag_decode(uint64_t value) {
    int64_t magnitude = (int64_t)(value >> 1);
    return (value & 1U) != 0 ? -magnitude - 1 : magnitude;
}

static uint32_t crc32_update(
    uint32_t crc,
    const unsigned char *data,
    size_t size) {
    size_t i;
    for (i = 0; i < size; ++i) {
        unsigned bit;
        crc ^= data[i];
        for (bit = 0; bit < 8; ++bit) {
            uint32_t mask = (uint32_t)-(int32_t)(crc & 1U);
            crc = (crc >> 1) ^ (0xedb88320U & mask);
        }
    }
    return crc;
}

static uint32_t block_crc32(const unsigned char *data, size_t size) {
    static const unsigned char zeros[4] = {0, 0, 0, 0};
    uint32_t crc = 0xffffffffU;
    if (size < TSDB_BLOCK_HEADER_BYTES) return 0;
    crc = crc32_update(crc, data, 28);
    crc = crc32_update(crc, zeros, sizeof(zeros));
    crc = crc32_update(
        crc,
        data + TSDB_BLOCK_HEADER_BYTES,
        size - TSDB_BLOCK_HEADER_BYTES);
    return ~crc;
}

uint64_t tsdb_double_to_bits(double value) {
    uint64_t bits;
    memcpy(&bits, &value, sizeof(bits));
    return bits;
}

double tsdb_bits_to_double(uint64_t bits) {
    double value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

int tsdb_block_encode(
    const TsdbCodecPoint *points,
    uint32_t count,
    unsigned char **output,
    size_t *output_size,
    int *value_codec) {
    size_t timestamp_size = 0;
    size_t xor_size = 0;
    size_t raw_size;
    size_t payload_size;
    size_t total_size;
    unsigned char *buffer;
    unsigned char *timestamp_out;
    unsigned char *value_out;
    uint64_t previous_delta = 0;
    uint64_t previous_bits = 0;
    uint32_t i;
    int codec;

    if (!output || !output_size || !value_codec) return TSDB_CODEC_INVALID;
    *output = NULL;
    *output_size = 0;
    *value_codec = 0;
    if (count == 0 || count > TSDB_BLOCK_MAX_POINTS || !points) {
        return TSDB_CODEC_INVALID;
    }

    for (i = 1; i < count; ++i) {
        __int128 delta128 = (__int128)points[i].timestamp_ms -
                            (__int128)points[i - 1].timestamp_ms;
        if (delta128 <= 0 || delta128 > INT64_MAX) return TSDB_CODEC_RANGE;
        if (i == 1) {
            previous_delta = (uint64_t)delta128;
            timestamp_size += uleb_size(previous_delta);
        } else {
            __int128 dd128 = delta128 - (__int128)previous_delta;
            int64_t dd;
            if (dd128 < INT64_MIN || dd128 > INT64_MAX) {
                return TSDB_CODEC_RANGE;
            }
            dd = (int64_t)dd128;
            timestamp_size += uleb_size(zigzag_encode(dd));
            previous_delta = (uint64_t)delta128;
        }
    }

    xor_size = 8;
    previous_bits = points[0].value_bits;
    for (i = 1; i < count; ++i) {
        uint64_t x = previous_bits ^ points[i].value_bits;
        xor_size += uleb_size(x);
        previous_bits = points[i].value_bits;
    }
    raw_size = (size_t)count * 8;
    codec = xor_size < raw_size ? 1 : 0;
    payload_size = timestamp_size + (codec ? xor_size : raw_size);
    if (payload_size > UINT32_MAX ||
        payload_size > SIZE_MAX - TSDB_BLOCK_HEADER_BYTES) {
        return TSDB_CODEC_RANGE;
    }
    total_size = TSDB_BLOCK_HEADER_BYTES + payload_size;
    buffer = (unsigned char *)malloc(total_size);
    if (!buffer) return TSDB_CODEC_NOMEM;
    memset(buffer, 0, TSDB_BLOCK_HEADER_BYTES);

    buffer[0] = TSDB_MAGIC_0;
    buffer[1] = TSDB_MAGIC_1;
    buffer[2] = TSDB_MAGIC_2;
    buffer[3] = TSDB_MAGIC_3;
    buffer[4] = 1;
    buffer[5] = 1;
    buffer[6] = (unsigned char)codec;
    buffer[7] = 0;
    put_u32(buffer + 8, count);
    put_u64(buffer + 12, (uint64_t)points[0].timestamp_ms);
    put_u32(buffer + 20, (uint32_t)timestamp_size);
    put_u32(buffer + 24, (uint32_t)(codec ? xor_size : raw_size));

    timestamp_out = buffer + TSDB_BLOCK_HEADER_BYTES;
    previous_delta = 0;
    for (i = 1; i < count; ++i) {
        uint64_t delta = (uint64_t)(
            (__int128)points[i].timestamp_ms -
            (__int128)points[i - 1].timestamp_ms);
        if (i == 1) {
            timestamp_out = put_uleb(timestamp_out, delta);
        } else {
            int64_t dd = (int64_t)((__int128)delta -
                                   (__int128)previous_delta);
            timestamp_out = put_uleb(timestamp_out, zigzag_encode(dd));
        }
        previous_delta = delta;
    }

    value_out = buffer + TSDB_BLOCK_HEADER_BYTES + timestamp_size;
    if (codec) {
        put_u64(value_out, points[0].value_bits);
        value_out += 8;
        previous_bits = points[0].value_bits;
        for (i = 1; i < count; ++i) {
            value_out = put_uleb(
                value_out,
                previous_bits ^ points[i].value_bits);
            previous_bits = points[i].value_bits;
        }
    } else {
        for (i = 0; i < count; ++i) {
            put_u64(value_out + (size_t)i * 8, points[i].value_bits);
        }
    }

    put_u32(buffer + 28, block_crc32(buffer, total_size));
    *output = buffer;
    *output_size = total_size;
    *value_codec = codec;
    return TSDB_CODEC_OK;
}

int tsdb_block_decode(
    const void *input,
    size_t input_size,
    TsdbCodecPoint **points,
    uint32_t *count,
    int *value_codec) {
    const unsigned char *buffer = (const unsigned char *)input;
    const unsigned char *timestamp_cursor;
    const unsigned char *timestamp_end;
    const unsigned char *value_cursor;
    const unsigned char *value_end;
    TsdbCodecPoint *decoded;
    uint32_t point_count;
    uint32_t timestamp_size;
    uint32_t value_size;
    size_t payload_size;
    uint64_t previous_delta = 0;
    uint64_t previous_bits = 0;
    uint32_t i;
    int codec;

    if (!points || !count || !value_codec) return TSDB_CODEC_INVALID;
    *points = NULL;
    *count = 0;
    *value_codec = 0;
    if (!buffer || input_size < TSDB_BLOCK_HEADER_BYTES) {
        return TSDB_CODEC_CORRUPT;
    }
    if (buffer[0] != TSDB_MAGIC_0 || buffer[1] != TSDB_MAGIC_1 ||
        buffer[2] != TSDB_MAGIC_2 || buffer[3] != TSDB_MAGIC_3 ||
        buffer[4] != 1 || buffer[5] != 1 || buffer[7] != 0) {
        return TSDB_CODEC_CORRUPT;
    }
    codec = buffer[6];
    if (codec != 0 && codec != 1) return TSDB_CODEC_CORRUPT;
    point_count = get_u32(buffer + 8);
    timestamp_size = get_u32(buffer + 20);
    value_size = get_u32(buffer + 24);
    if (point_count == 0 || point_count > TSDB_BLOCK_MAX_POINTS) {
        return TSDB_CODEC_CORRUPT;
    }
    payload_size = (size_t)timestamp_size + value_size;
    if (payload_size > input_size - TSDB_BLOCK_HEADER_BYTES ||
        TSDB_BLOCK_HEADER_BYTES + payload_size != input_size) {
        return TSDB_CODEC_CORRUPT;
    }
    if (block_crc32(buffer, input_size) != get_u32(buffer + 28)) {
        return TSDB_CODEC_CORRUPT;
    }
    if ((!codec && value_size != (size_t)point_count * 8) ||
        (codec && value_size < 8)) {
        return TSDB_CODEC_CORRUPT;
    }
    decoded = (TsdbCodecPoint *)calloc(point_count, sizeof(*decoded));
    if (!decoded) return TSDB_CODEC_NOMEM;

    decoded[0].timestamp_ms = u64_to_i64(get_u64(buffer + 12));
    timestamp_cursor = buffer + TSDB_BLOCK_HEADER_BYTES;
    timestamp_end = timestamp_cursor + timestamp_size;
    for (i = 1; i < point_count; ++i) {
        uint64_t encoded;
        uint64_t delta;
        __int128 timestamp;
        int rc = get_uleb(&timestamp_cursor, timestamp_end, &encoded);
        if (rc != TSDB_CODEC_OK) goto corrupt;
        if (i == 1) {
            delta = encoded;
            if (delta == 0 || delta > INT64_MAX) goto corrupt;
        } else {
            int64_t dd = zigzag_decode(encoded);
            __int128 delta128 = (__int128)previous_delta + dd;
            if (delta128 <= 0 || delta128 > INT64_MAX) goto corrupt;
            delta = (uint64_t)delta128;
        }
        timestamp = (__int128)decoded[i - 1].timestamp_ms + delta;
        if (timestamp > INT64_MAX) goto corrupt;
        decoded[i].timestamp_ms = (int64_t)timestamp;
        previous_delta = delta;
    }
    if (timestamp_cursor != timestamp_end) goto corrupt;

    value_cursor = buffer + TSDB_BLOCK_HEADER_BYTES + timestamp_size;
    value_end = value_cursor + value_size;
    if (codec) {
        previous_bits = get_u64(value_cursor);
        decoded[0].value_bits = previous_bits;
        value_cursor += 8;
        for (i = 1; i < point_count; ++i) {
            uint64_t x;
            int rc = get_uleb(&value_cursor, value_end, &x);
            if (rc != TSDB_CODEC_OK) goto corrupt;
            previous_bits ^= x;
            decoded[i].value_bits = previous_bits;
        }
        if (value_cursor != value_end) goto corrupt;
    } else {
        for (i = 0; i < point_count; ++i) {
            decoded[i].value_bits = get_u64(value_cursor + (size_t)i * 8);
        }
    }

    *points = decoded;
    *count = point_count;
    *value_codec = codec;
    return TSDB_CODEC_OK;

corrupt:
    free(decoded);
    return TSDB_CODEC_CORRUPT;
}

const char *tsdb_codec_error(int code) {
    switch (code) {
        case TSDB_CODEC_OK:
            return "ok";
        case TSDB_CODEC_NOMEM:
            return "out of memory";
        case TSDB_CODEC_INVALID:
            return "invalid argument";
        case TSDB_CODEC_RANGE:
            return "value out of range";
        case TSDB_CODEC_CORRUPT:
            return "corrupt block";
        default:
            return "unknown codec error";
    }
}
