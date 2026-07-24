/**
 * Subset of wa-sqlite used to iterate prepared statements.
 *
 * wa-sqlite's bundled `statements()` helper starts `finalize()` without
 * awaiting it. With an async VFS, the operation that used the statement can
 * therefore resolve before SQLite has actually finalized it. A store closed
 * immediately afterward may fail with SQLITE_BUSY and leave its OPFS access
 * handle open.
 */
export interface FinalizingStatementApi {
	statements(db: number, sql: string): AsyncIterable<number>;
	str_new(db: number, sql: string): number;
	str_value(str: number): number;
	str_finish(str: number): void;
	prepare_v2(
		db: number,
		sql: number
	): Promise<{ stmt: number; sql: number } | null>;
	finalize(stmt: number): Promise<number>;
}

/** Replace wa-sqlite's iterator with one that includes finalization in its lifetime. */
export function installAwaitedStatementFinalization(
	sqlite3: FinalizingStatementApi
): void {
	sqlite3.statements = (db: number, sql: string): AsyncIterable<number> =>
		(async function* () {
			const str = sqlite3.str_new(db, sql);
			let nextSql = sqlite3.str_value(str);
			try {
				while (true) {
					const prepared = await sqlite3.prepare_v2(db, nextSql);
					if (!prepared) return;
					nextSql = prepared.sql;
					try {
						yield prepared.stmt;
					} finally {
						await sqlite3.finalize(prepared.stmt);
					}
				}
			} finally {
				sqlite3.str_finish(str);
			}
		})();
}
