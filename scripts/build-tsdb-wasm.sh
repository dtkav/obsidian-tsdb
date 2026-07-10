#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WA_SQLITE_DIR="${TSDB_WA_SQLITE_DIR:-/tmp/obsidian-metrics-wa-sqlite}"
WA_SQLITE_COMMIT="a110948636473279dd3590f0b980bc9c6a9d6407"
EMSDK_IMAGE="emscripten/emsdk:3.1.25"

if [[ ! -d "$WA_SQLITE_DIR/.git" ]]; then
	git clone https://github.com/rhashimoto/wa-sqlite.git "$WA_SQLITE_DIR"
fi

git -C "$WA_SQLITE_DIR" fetch origin "$WA_SQLITE_COMMIT"
git -C "$WA_SQLITE_DIR" checkout --detach "$WA_SQLITE_COMMIT"

docker run --rm \
	-v "$WA_SQLITE_DIR:/wa-sqlite" \
	-v "$ROOT_DIR/sqlite-tsdb:/sqlite-tsdb:ro" \
	-w /wa-sqlite \
	"$EMSDK_IMAGE" \
	make -f /sqlite-tsdb/adapters/wa-sqlite/wa-sqlite-v1.mk \
		SQLITE_TSDB_DIR=/sqlite-tsdb clean

docker run --rm \
	-v "$WA_SQLITE_DIR:/wa-sqlite" \
	-v "$ROOT_DIR/sqlite-tsdb:/sqlite-tsdb:ro" \
	-w /wa-sqlite \
	"$EMSDK_IMAGE" \
	make -f /sqlite-tsdb/adapters/wa-sqlite/wa-sqlite-v1.mk \
		SQLITE_TSDB_DIR=/sqlite-tsdb dist/wa-sqlite-async.mjs

cp "$WA_SQLITE_DIR/dist/wa-sqlite-async.mjs" \
	"$ROOT_DIR/node_modules/wa-sqlite/dist/wa-sqlite-async.mjs"
cp "$WA_SQLITE_DIR/dist/wa-sqlite-async.wasm" \
	"$ROOT_DIR/node_modules/wa-sqlite/dist/wa-sqlite-async.wasm"

node "$ROOT_DIR/scripts/verify-tsdb-wasm.mjs"
