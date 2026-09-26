import { describe, expect, it } from "vitest";
import {
	COMPACTION_ACTIVE_PAUSE_MS,
	COMPACTION_BATCH_MAX_POINTS,
	COMPACTION_BATCH_MIN_POINTS,
	COMPACTION_BATCH_PAUSE_MS,
	COMPACTION_FRESH_BACKLOG_AGE_MS,
	COMPACTION_FRESH_BACKLOG_MIN_POINTS,
	COMPACTION_FRESH_PAUSE_MS,
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
		expect(nextCompactionPointLimit(2048, 400)).toBe(1024);
		expect(nextCompactionPointLimit(2048, 10000)).toBe(
			COMPACTION_BATCH_MIN_POINTS
		);
	});

	it("raises the point limit gradually after a fast slice", () => {
		expect(nextCompactionPointLimit(1024, 50)).toBe(1280);
		expect(nextCompactionPointLimit(2000, 50)).toBe(
			COMPACTION_BATCH_MAX_POINTS
		);
	});

	it("keeps the point limit within the target band", () => {
		expect(nextCompactionPointLimit(1024, 250)).toBe(1024);
		expect(nextCompactionPointLimit(1024, Number.NaN)).toBe(1024);
	});

	it("never shrinks below a floor that outruns ingest", () => {
		// A batch is mostly fixed cost, so the smallest batch still moves
		// hundreds of points per pause; a slow batch shrinks toward that
		// floor and no further.
		expect(nextCompactionPointLimit(512, 100000)).toBe(
			COMPACTION_BATCH_MIN_POINTS
		);
		expect(COMPACTION_BATCH_MIN_POINTS).toBeGreaterThanOrEqual(512);
	});

	it("honors a backlog floor while retaining adaptive upper bounds", () => {
		expect(nextCompactionPointLimit(512, 400, 2048)).toBe(2048);
		expect(nextCompactionPointLimit(2048, 10000, 1024)).toBe(1024);
		expect(nextCompactionPointLimit(2048, 50, 1024)).toBe(
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

	it("catches up backlog faster while foreground queries are idle", () => {
		expect(
			compactionPauseMs({
				backlogAgeMs: COMPACTION_URGENT_BACKLOG_AGE_MS,
				recentQueryAgeMs: Number.POSITIVE_INFINITY,
				recentQueryQueueWaitMs: 0,
			})
		).toBe(COMPACTION_URGENT_PAUSE_MS);
		expect(
			compactionPauseMs({
				backlogAgeMs: COMPACTION_FRESH_BACKLOG_AGE_MS,
				recentQueryAgeMs: Number.POSITIVE_INFINITY,
				recentQueryQueueWaitMs: 0,
			})
		).toBe(COMPACTION_FRESH_PAUSE_MS);
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
				backlogAgeMs: COMPACTION_FRESH_BACKLOG_AGE_MS,
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
		expect(nextVacuumPageLimit(256, 400)).toBe(128);
		expect(nextVacuumPageLimit(256, 10000)).toBe(VACUUM_BATCH_MIN_PAGES);
	});

	it("raises the page limit gradually after a fast slice", () => {
		expect(nextVacuumPageLimit(256, 50)).toBe(320);
		expect(nextVacuumPageLimit(1000, 50)).toBe(VACUUM_BATCH_MAX_PAGES);
	});

	it("leaves the page limit stable in the target band", () => {
		expect(nextVacuumPageLimit(256, 250)).toBe(256);
		expect(nextVacuumPageLimit(256, Number.NaN)).toBe(256);
	});
});
