#include "tsdb_codec.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t read_wrapped_u64(const uint8_t *data, size_t size, size_t offset) {
    uint64_t value = 0;
    int i;
    if (size == 0) return 0;
    for (i = 0; i < 8; ++i) {
        value |= (uint64_t)data[(offset + (size_t)i) % size] << (i * 8);
    }
    return value;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    TsdbCodecPoint *decoded = NULL;
    uint32_t decoded_count = 0;
    int decoded_codec = 0;
    TsdbCodecPoint *points;
    unsigned char *encoded = NULL;
    size_t encoded_size = 0;
    uint32_t count;
    uint32_t i;
    int encoded_codec = 0;
    int rc;

    rc = tsdb_block_decode(data, size, &decoded, &decoded_count, &decoded_codec);
    if (rc == TSDB_CODEC_OK) free(decoded);

    if (size == 0) return 0;
    count = 1 + (uint32_t)((size / 16) % 2048);
    points = (TsdbCodecPoint *)calloc(count, sizeof(*points));
    if (!points) return 0;
    points[0].timestamp_ms = (int64_t)(read_wrapped_u64(data, size, 0) % 1000000);
    points[0].value_bits = read_wrapped_u64(data, size, 8);
    for (i = 1; i < count; ++i) {
        uint64_t delta = 1 + read_wrapped_u64(data, size, (size_t)i * 16) % 100000;
        points[i].timestamp_ms = points[i - 1].timestamp_ms + (int64_t)delta;
        points[i].value_bits = read_wrapped_u64(data, size, (size_t)i * 16 + 8);
    }
    rc = tsdb_block_encode(
        points,
        count,
        &encoded,
        &encoded_size,
        &encoded_codec);
    if (rc != TSDB_CODEC_OK) abort();
    rc = tsdb_block_decode(
        encoded,
        encoded_size,
        &decoded,
        &decoded_count,
        &decoded_codec);
    if (rc != TSDB_CODEC_OK || decoded_count != count ||
        decoded_codec != encoded_codec ||
        memcmp(points, decoded, (size_t)count * sizeof(*points)) != 0) {
        abort();
    }
    free(decoded);
    free(encoded);
    free(points);
    return 0;
}
