import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";

describe("mergeSettings", () => {
	it("keeps non-OPFS storage engines disabled by default", () => {
		expect(DEFAULT_SETTINGS.storage.allowLegacyBackends).toBe(false);
		expect(mergeSettings({}).storage.allowLegacyBackends).toBe(false);
	});

	it("preserves an explicit non-OPFS storage opt-in", () => {
		const settings = mergeSettings({
			storage: {
				allowLegacyBackends: true,
			},
		});

		expect(settings.storage.allowLegacyBackends).toBe(true);
	});
});
