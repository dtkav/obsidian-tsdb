import { describe, expect, it, vi } from "vitest";
import {
	FinalizingStatementApi,
	installAwaitedStatementFinalization,
} from "../src/storage/sqlite-statements";

describe("awaited SQLite statement finalization", () => {
	it("does not finish iteration until the yielded statement is finalized", async () => {
		let releaseFinalize!: () => void;
		const finalizeGate = new Promise<void>((resolve) => {
			releaseFinalize = resolve;
		});
		const api = {
			statements: vi.fn(),
			str_new: vi.fn(() => 10),
			str_value: vi.fn(() => 20),
			str_finish: vi.fn(),
			prepare_v2: vi
				.fn()
				.mockResolvedValueOnce({ stmt: 30, sql: 40 })
				.mockResolvedValueOnce(null),
			finalize: vi.fn(async () => {
				await finalizeGate;
				return 0;
			}),
		} as unknown as FinalizingStatementApi;
		installAwaitedStatementFinalization(api);

		let finished = false;
		const iteration = (async () => {
			for await (const stmt of api.statements(1, "SELECT 1")) {
				expect(stmt).toBe(30);
			}
			finished = true;
		})();
		await vi.waitFor(() => expect(api.finalize).toHaveBeenCalledWith(30));
		expect(finished).toBe(false);
		releaseFinalize();
		await iteration;
		expect(finished).toBe(true);
		expect(api.str_finish).toHaveBeenCalledWith(10);
	});

	it("finalizes a statement when its consumer stops early", async () => {
		const api = {
			statements: vi.fn(),
			str_new: vi.fn(() => 10),
			str_value: vi.fn(() => 20),
			str_finish: vi.fn(),
			prepare_v2: vi.fn().mockResolvedValue({ stmt: 30, sql: 40 }),
			finalize: vi.fn().mockResolvedValue(0),
		} as unknown as FinalizingStatementApi;
		installAwaitedStatementFinalization(api);

		for await (const _stmt of api.statements(1, "SELECT 1")) break;

		expect(api.finalize).toHaveBeenCalledWith(30);
		expect(api.str_finish).toHaveBeenCalledWith(10);
	});
});
