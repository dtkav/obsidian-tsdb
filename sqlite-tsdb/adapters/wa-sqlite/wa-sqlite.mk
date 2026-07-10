ifndef SQLITE_TSDB_DIR
$(error SQLITE_TSDB_DIR must be the absolute path to sqlite-tsdb)
endif

CFILES_EXTRA += sqlite_tsdb.c tsdb_codec.c tsdb_wasm.c
CFLAGS_EXTRA += -I'$(SQLITE_TSDB_DIR)/include' -I'$(SQLITE_TSDB_DIR)/src'
EMFLAGS_EXTRA += -sINCOMING_MODULE_JS_API=wasmBinary

vpath %.c $(SQLITE_TSDB_DIR)/src
vpath %.c $(SQLITE_TSDB_DIR)/adapters/wa-sqlite

include Makefile
