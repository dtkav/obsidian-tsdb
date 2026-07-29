import { describe, expect, it } from "vitest";
import {
	COMPACTION_ACTIVE_PAUSE_MS,
	COMPACTION_BATCH_MAX_POINTS,
	COMPACTION_BATCH_MIN_POINTS,
	COMPACTION_BATCH_PAUSE_MS,
	COMPACTION_FRESH_BACKLOG_MIN_POINTS,
	COMPACTION_PRESSURED_PAUSE_MS,
	COMPACTION_URGENT_BACKLOG_AGE_MS,
	COMPACTION_URGENT_BACKLOG_MIN_POINTS,
	COMPACTION_URGENT_PAUSE_MS,
	compactionPauseMs,
	compactionPointFloor,
	nextCompactionPointLimit,
} from "../src/storage/compaction";
import {
	VACUUM_BATCH_MAX_PAGES,
	VACUUM_BATCH_MIN_PAGES,
	nextVacuumPageLimit,
} from "../src/storage/vacuum";

describe("compaction scheduling", () => {
	it("reduces the point limit after a slow slice", () => {
		expect(nextCompactionPointLimit(512, 100)).toBe(204);
		expect(nextCompactionPointLimit(512, 1000)).toBe(
			COMPACTION_BATCH_MIN_POINTS
		);
	});

	it("raises the point limit gradually after a fast slice", () => {
		expect(nextCompactionPointLimit(128, 10)).toBe(160);
		expect(nextCompactionPointLimit(500, 10)).toBe(
			COMPACTION_BATCH_MAX_POINTS
		);
	});

	it("keeps the point limit within the target band", () => {
		expect(nextCompactionPointLimit(256, 50)).toBe(256);
		expect(nextCompactionPointLimit(256, Number.NaN)).toBe(256);
	});

	it("honors a backlog floor while retaining adaptive upper bounds", () => {
		expect(nextCompactionPointLimit(64, 100, 512)).toBe(512);
		expect(nextCompactionPointLimit(512, 1000, 256)).toBe(256);
		expect(nextCompactionPointLimit(512, 10, 256)).toBe(
			COMPACTION_BATCH_MAX_POINTS
		);
	});

	it("prioritizes recent foreground query pressure over old backlog", () => {
		expect(
			compactionPauseMs({
				backlogAgeMs: COMPACTION_URGENT_BACKLOG_AGE_MS,
				recentQueryAgeMs: 100,
				recentQueryQueueWaitMs: 10,
			})
		).toBe(COMPACTION_ACTIVE_PAUSE_MS);
		expect(
			compactionPauseMs({
				backlogAgeMs: COMPACTION_URGENT_BACKLOG_AGE_MS,
				recentQueryAgeMs: 100,
				recentQueryQueueWaitMs: 150,
			})
		).toBe(COMPACTION_PRESSURED_PAUSE_MS);
	});

	it("catches up old backlog only while foreground queries are idle", () => {
		expect(
			compactionPauseMs({
				backlogAgeMs: COMPACTION_URGENT_BACKLOG_AGE_MS,
				recentQueryAgeMs: Number.POSITIVE_INFINITY,
				recentQueryQueueWaitMs: 0,
			})
		).toBe(COMPACTION_URGENT_PAUSE_MS);
		expect(
			compactionPauseMs({
				backlogAgeMs: 0,
				recentQueryAgeMs: Number.POSITIVE_INFINITY,
				recentQueryQueueWaitMs: 0,
			})
		).toBe(COMPACTION_BATCH_PAUSE_MS);
	});

	it("raises the point floor for idle backlog but releases it for queries", () => {
		expect(
			compactionPointFloor({
				backlogAgeMs: COMPACTION_URGENT_BACKLOG_AGE_MS,
				recentQueryAgeMs: Number.POSITIVE_INFINITY,
			})
		).toBe(COMPACTION_URGENT_BACKLOG_MIN_POINTS);
		expect(
			compactionPointFloor({
				backlogAgeMs: 4 * 60 * 60 * 1000,
				recentQueryAgeMs: Number.POSITIVE_INFINITY,
			})
		).toBe(COMPACTION_FRESH_BACKLOG_MIN_POINTS);
		expect(
			compactionPointFloor({
				backlogAgeMs: COMPACTION_URGENT_BACKLOG_AGE_MS,
				recentQueryAgeMs: 100,
			})
		).toBe(COMPACTION_BATCH_MIN_POINTS);
	});
});

describe("vacuum scheduling", () => {
	it("reduces the page limit after a slow slice", () => {
		expect(nextVacuumPageLimit(64, 100)).toBe(25);
		expect(nextVacuumPageLimit(64, 1000)).toBe(VACUUM_BATCH_MIN_PAGES);
	});

	it("raises the page limit gradually after a fast slice", () => {
		expect(nextVacuumPageLimit(64, 10)).toBe(80);
		expect(nextVacuumPageLimit(250, 10)).toBe(VACUUM_BATCH_MAX_PAGES);
	});

	it("leaves the page limit stable in the target band", () => {
		expect(nextVacuumPageLimit(64, 50)).toBe(64);
		expect(nextVacuumPageLimit(64, Number.NaN)).toBe(64);
	});
});
