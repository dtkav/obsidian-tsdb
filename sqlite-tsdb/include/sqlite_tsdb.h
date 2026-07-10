#ifndef SQLITE_TSDB_H
#define SQLITE_TSDB_H

#include <sqlite3.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SQLITE_TSDB_VERSION "0.1.0-dev"

int sqlite3_tsdb_register(sqlite3 *db);

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_sqlitetsdb_init(
    sqlite3 *db,
    char **error_message,
    const sqlite3_api_routines *api);

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_tsdb_init(
    sqlite3 *db,
    char **error_message,
    const sqlite3_api_routines *api);

#ifdef __cplusplus
}
#endif

#endif
