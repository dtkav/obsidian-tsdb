CC ?= cc
CLANG ?= clang
PYTHON ?= python3
BUILD_DIR ?= build

CPPFLAGS := -Iinclude -Isrc
CFLAGS_COMMON := -std=c11 -fPIC -Wall -Wextra -Werror
CFLAGS_RELEASE := -O3 -DNDEBUG
LDLIBS := -lsqlite3 -lm
CXX_RUNTIME_DIR := $(dir $(shell $(CC) -print-file-name=libstdc++.so))

EXTENSION := $(BUILD_DIR)/sqlite_tsdb.so
CODEC_TEST := $(BUILD_DIR)/codec_test
NATIVE_TEST := $(BUILD_DIR)/native_test
SANITIZER_TEST := $(BUILD_DIR)/native_test_sanitize
CODEC_FUZZ := $(BUILD_DIR)/codec_fuzz

.PHONY: all clean test stability benchmark sanitize fuzz

all: $(EXTENSION) $(CODEC_TEST) $(NATIVE_TEST)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/tsdb_codec.o: src/tsdb_codec.c src/tsdb_codec.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS_COMMON) $(CFLAGS_RELEASE) -c $< -o $@

$(BUILD_DIR)/sqlite_tsdb.o: src/sqlite_tsdb.c src/tsdb_codec.h include/sqlite_tsdb.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS_COMMON) $(CFLAGS_RELEASE) -c $< -o $@

$(EXTENSION): $(BUILD_DIR)/sqlite_tsdb.o $(BUILD_DIR)/tsdb_codec.o
	$(CC) -shared $^ $(LDLIBS) -o $@

$(CODEC_TEST): tests/codec_test.c src/tsdb_codec.c src/tsdb_codec.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS_COMMON) -O2 tests/codec_test.c src/tsdb_codec.c -lm -o $@

$(NATIVE_TEST): tests/native_test.c src/sqlite_tsdb.c src/tsdb_codec.c include/sqlite_tsdb.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS_COMMON) -O2 -DSQLITE_CORE \
		tests/native_test.c src/sqlite_tsdb.c src/tsdb_codec.c $(LDLIBS) -o $@

$(SANITIZER_TEST): tests/native_test.c src/sqlite_tsdb.c src/tsdb_codec.c include/sqlite_tsdb.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS_COMMON) -O1 -g -DSQLITE_CORE \
		-fsanitize=address,undefined -fno-omit-frame-pointer \
		tests/native_test.c src/sqlite_tsdb.c src/tsdb_codec.c $(LDLIBS) -o $@

$(CODEC_FUZZ): tests/codec_fuzz.c src/tsdb_codec.c src/tsdb_codec.h | $(BUILD_DIR)
	$(CLANG) $(CPPFLAGS) -std=c11 -O1 -g \
		-fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer \
		tests/codec_fuzz.c src/tsdb_codec.c -L$(CXX_RUNTIME_DIR) -o $@

test: all
	$(CODEC_TEST)
	$(NATIVE_TEST)
	$(PYTHON) tests/stability_test.py $(EXTENSION)

stability: $(EXTENSION)
	$(PYTHON) tests/stability_test.py $(EXTENSION) --seeds 50 --operations 5000

benchmark: $(EXTENSION)
	$(PYTHON) bench/benchmark.py $(EXTENSION)

sanitize: $(SANITIZER_TEST)
	ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=print_stacktrace=1 $(SANITIZER_TEST)

fuzz: $(CODEC_FUZZ)
	ASAN_OPTIONS=detect_leaks=0 $(CODEC_FUZZ) -runs=100000 -max_len=65536

clean:
	rm -rf $(BUILD_DIR)
