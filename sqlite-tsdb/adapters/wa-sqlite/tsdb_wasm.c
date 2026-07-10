#include <emscripten/emscripten.h>
#include <sqlite3.h>

#include "sqlite_tsdb.h"

/* Register the extension for every connection opened after this call. */
EMSCRIPTEN_KEEPALIVE
int sqlite3_tsdb_auto_extension(void) {
    return sqlite3_auto_extension((void (*)(void))sqlite3_sqlitetsdb_init);
}
