ifndef SQLITE_TSDB_DIR
$(error SQLITE_TSDB_DIR must be the absolute path to sqlite-tsdb)
endif

override CFLAGS_COMMON = \
	-I'deps/$(SQLITE_AMALGAMATION)' \
	-I'$(SQLITE_TSDB_DIR)/include' \
	-I'$(SQLITE_TSDB_DIR)/src' \
	-Wno-non-literal-null-conversion

override EMFLAGS_COMMON = \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s WASM=1 \
	-s INVOKE_RUN \
	-s ENVIRONMENT="web,worker" \
	-sINCOMING_MODULE_JS_API=wasmBinary

override BITCODE_FILES_DEBUG = \
	tmp/bc/debug/sqlite3.bc tmp/bc/debug/extension-functions.bc \
	tmp/bc/debug/libfunction.bc tmp/bc/debug/libmodule.bc \
	tmp/bc/debug/libvfs.bc tmp/bc/debug/sqlite_tsdb.bc \
	tmp/bc/debug/tsdb_codec.bc tmp/bc/debug/tsdb_wasm.bc

override BITCODE_FILES_DIST = \
	tmp/bc/dist/sqlite3.bc tmp/bc/dist/extension-functions.bc \
	tmp/bc/dist/libfunction.bc tmp/bc/dist/libmodule.bc \
	tmp/bc/dist/libvfs.bc tmp/bc/dist/sqlite_tsdb.bc \
	tmp/bc/dist/tsdb_codec.bc tmp/bc/dist/tsdb_wasm.bc

vpath %.c $(SQLITE_TSDB_DIR)/src
vpath %.c $(SQLITE_TSDB_DIR)/adapters/wa-sqlite

include Makefile

tmp/bc/debug/sqlite_tsdb.bc: sqlite_tsdb.c
	mkdir -p tmp/bc/debug
	$(EMCC) $(CFLAGS_DEBUG) $(WASQLITE_DEFINES) $< -c -o $@

tmp/bc/debug/tsdb_codec.bc: tsdb_codec.c
	mkdir -p tmp/bc/debug
	$(EMCC) $(CFLAGS_DEBUG) $(WASQLITE_DEFINES) $< -c -o $@

tmp/bc/debug/tsdb_wasm.bc: tsdb_wasm.c
	mkdir -p tmp/bc/debug
	$(EMCC) $(CFLAGS_DEBUG) $(WASQLITE_DEFINES) $< -c -o $@

tmp/bc/dist/sqlite_tsdb.bc: sqlite_tsdb.c
	mkdir -p tmp/bc/dist
	$(EMCC) $(CFLAGS_DIST) $(WASQLITE_DEFINES) $< -c -o $@

tmp/bc/dist/tsdb_codec.bc: tsdb_codec.c
	mkdir -p tmp/bc/dist
	$(EMCC) $(CFLAGS_DIST) $(WASQLITE_DEFINES) $< -c -o $@

tmp/bc/dist/tsdb_wasm.bc: tsdb_wasm.c
	mkdir -p tmp/bc/dist
	$(EMCC) $(CFLAGS_DIST) $(WASQLITE_DEFINES) $< -c -o $@
