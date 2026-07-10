# wa-sqlite adapter

This adapter statically links sqlite-tsdb into wa-sqlite. It does not fork the
wa-sqlite JavaScript API and does not make sqlite-tsdb depend on wa-sqlite.

## Build

Clone wa-sqlite and install its documented Emscripten prerequisites. From any
directory, run:

```bash
make -C /path/to/wa-sqlite \
  -f /path/to/sqlite-tsdb/adapters/wa-sqlite/wa-sqlite.mk \
  SQLITE_TSDB_DIR=/path/to/sqlite-tsdb \
  dist/wa-sqlite.mjs dist/wa-sqlite-async.mjs
```

For the published wa-sqlite `1.0.0` npm package used by the Obsidian plugin,
pin wa-sqlite to commit `a110948636473279dd3590f0b980bc9c6a9d6407` and use the
version-specific overlay. That commit matches the package's VFS callback ABI;
the later Git `v1.0.0` tag does not:

```bash
make -C /path/to/wa-sqlite-1.0.0 \
  -f /path/to/sqlite-tsdb/adapters/wa-sqlite/wa-sqlite-v1.mk \
  SQLITE_TSDB_DIR=/path/to/sqlite-tsdb \
  dist/wa-sqlite.mjs dist/wa-sqlite-async.mjs
```

The output `.mjs` and `.wasm` files are wa-sqlite artifacts with the TSDB code
linked in. The build also preserves Emscripten's `wasmBinary` factory input so
the artifact can be embedded in an Obsidian bundle. The upstream SQLite
amalgamation remains the only SQLite copy.

## Initialize

Call the exported registration function after the Emscripten module resolves
and before opening a database:

```ts
const module = await SQLiteAsyncESMFactory({ wasmBinary });
const rc = module.ccall(
  "sqlite3_tsdb_auto_extension",
  "number",
  [],
  []
);
if (rc !== 0) throw new Error(`sqlite-tsdb registration failed: ${rc}`);

const sqlite3 = SQLite.Factory(module);
const db = await sqlite3.open_v2(/* ... */);
```

Registration is process-local and idempotent for the expected single module
instance. Every SQLite connection opened afterward receives `tsdb`,
`tsdb_batch`, `tsdb_pack`, and `tsdb_version`.

Obsidian should keep the labels/series catalog in normal SQLite tables. Only
numeric samples belong in the TSDB virtual table. Packed `TSI1` input avoids a
JavaScript-to-Wasm call per sample, and `tsdb_pack()` avoids a Wasm-to-JavaScript
callback per result point.

Use the regular `wa-sqlite.mjs` build with a synchronous VFS such as
`AccessHandlePoolVFS`. Reserve `wa-sqlite-async.mjs` for VFS implementations
whose methods return promises. The module factory and minimized Wasm binary
must always come from the same build pair.

Run the boundary-aware benchmark against the generated artifact with:

```bash
node bench/wasm_benchmark.mjs \
  /path/to/wa-sqlite/dist/wa-sqlite-async.mjs \
  /path/to/wa-sqlite/dist/wa-sqlite-async.wasm \
  /path/to/wa-sqlite/src/sqlite-api.js
```
