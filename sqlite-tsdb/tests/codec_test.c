#include "tsdb_codec.h"

#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t next_random(uint64_t *state) {
    uint64_t x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    return x;
}

static void assert_round_trip(TsdbCodecPoint *input, uint32_t count) {
    unsigned char *encoded = NULL;
    size_t encoded_size = 0;
    TsdbCodecPoint *decoded = NULL;
    uint32_t decoded_count = 0;
    int encoded_codec = -1;
    int decoded_codec = -1;
    int rc;

    rc = tsdb_block_encode(
        input,
        count,
        &encoded,
        &encoded_size,
        &encoded_codec);
    assert(rc == TSDB_CODEC_OK);
    assert(encoded != NULL);
    assert(encoded_size >= TSDB_BLOCK_HEADER_BYTES);
    rc = tsdb_block_decode(
        encoded,
        encoded_size,
        &decoded,
        &decoded_count,
        &decoded_codec);
    assert(rc == TSDB_CODEC_OK);
    assert(decoded_count == count);
    assert(decoded_codec == encoded_codec);
    assert(memcmp(input, decoded, (size_t)count * sizeof(*input)) == 0);

    encoded[12] ^= 0x01;
    free(decoded);
    decoded = NULL;
    assert(tsdb_block_decode(
               encoded,
               encoded_size,
               &decoded,
               &decoded_count,
               &decoded_codec) == TSDB_CODEC_CORRUPT);
    assert(decoded == NULL);

    free(encoded);
}

int main(void) {
    TsdbCodecPoint one[] = {
        {1700000000000LL, tsdb_double_to_bits(-0.0)}
    };
    TsdbCodecPoint regular[2048];
    TsdbCodecPoint random_points[2048];
    uint64_t random_state = UINT64_C(0x9e3779b97f4a7c15);
    uint32_t i;
    unsigned char *encoded = NULL;
    size_t encoded_size = 0;
    int codec = -1;

    assert_round_trip(one, 1);
    for (i = 0; i < 2048; ++i) {
        regular[i].timestamp_ms = 1700000000000LL + (int64_t)i * 30000;
        regular[i].value_bits = tsdb_double_to_bits(42.0 + (double)(i % 4));
        random_points[i].timestamp_ms =
            1700000000000LL + (int64_t)i * 30000 + (i % 3);
        random_points[i].value_bits = next_random(&random_state);
    }
    assert_round_trip(regular, 2048);
    assert_round_trip(random_points, 2048);

    assert(tsdb_block_encode(
               regular,
               2048,
               &encoded,
               &encoded_size,
               &codec) == TSDB_CODEC_OK);
    assert(encoded_size < (size_t)2048 * 16);
    free(encoded);

    assert(tsdb_block_encode(NULL, 0, &encoded, &encoded_size, &codec) ==
           TSDB_CODEC_INVALID);
    regular[1].timestamp_ms = regular[0].timestamp_ms;
    assert(tsdb_block_encode(regular, 2, &encoded, &encoded_size, &codec) ==
           TSDB_CODEC_RANGE);

    printf("codec tests passed\n");
    return 0;
}
