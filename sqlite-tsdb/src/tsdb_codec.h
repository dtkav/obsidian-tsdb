#ifndef TSDB_CODEC_H
#define TSDB_CODEC_H

#include <stddef.h>
#include <stdint.h>

#define TSDB_CODEC_OK 0
#define TSDB_CODEC_NOMEM 1
#define TSDB_CODEC_INVALID 2
#define TSDB_CODEC_RANGE 3
#define TSDB_CODEC_CORRUPT 4

#define TSDB_BLOCK_HEADER_BYTES 32U
#define TSDB_BLOCK_MAX_POINTS 1048576U

typedef struct TsdbCodecPoint {
    int64_t timestamp_ms;
    uint64_t value_bits;
} TsdbCodecPoint;

int tsdb_block_encode(
    const TsdbCodecPoint *points,
    uint32_t count,
    unsigned char **output,
    size_t *output_size,
    int *value_codec);

int tsdb_block_decode(
    const void *input,
    size_t input_size,
    TsdbCodecPoint **points,
    uint32_t *count,
    int *value_codec);

const char *tsdb_codec_error(int code);

uint64_t tsdb_double_to_bits(double value);
double tsdb_bits_to_double(uint64_t bits);

#endif
