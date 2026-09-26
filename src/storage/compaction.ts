// Compaction pacing.
//
// Hot rows cost about 40 bytes each in two B-trees; the same samples cost a
// few bytes once they sit in delta-encoded blocks. Compaction therefore runs
// continuously against an exact cutoff a few minutes behind real time, and
// the pacer is sized by throughput, not latency: a batch costs a few tens of
// milliseconds of fixed work plus a fraction of a millisecond per point, so
// shrinking batches barely shortens them while cutting throughput. The point
// limit only moves within a band whose floor already outruns any realistic
// ingest rate.

/** Rows younger than this stay hot; everything older is compactable. */
export const COMPACTION_HOT_WINDOW_MS = 5 * 60 * 1000;
export const STARTUP_COMPACTION_DELAY_MS = 60 * 1000;
/** Re-check for compactable rows this often once a sweep found none. */
export const COMPACTION_SWEEP_MS = 60 * 1000;
export const COMPACTION_BACKLOG_RETRY_MS = 1000;
export const COMPACTION_BATCH_MIN_POINTS = 512;
export const COMPACTION_BATCH_MAX_POINTS = 2048;
export const COMPACTION_BATCH_TARGET_MS = 250;
export const COMPACTION_MAX_BATCHES_PER_SWEEP = 16;
export const COMPACTION_BATCH_PAUSE_MS = 250;
export const COMPACTION_URGENT_PAUSE_MS = 100;
export const COMPACTION_FRESH_PAUSE_MS = 150;
export const COMPACTION_ACTIVE_PAUSE_MS = 500;
export const COMPACTION_PRESSURED_PAUSE_MS = 1000;
export const COMPACTION_QUERY_ACTIVITY_WINDOW_MS = 3000;
export const COMPACTION_FRESH_BACKLOG_AGE_MS = 30 * 60 * 1000;
export const COMPACTION_URGENT_BACKLOG_AGE_MS = 2 * 60 * 60 * 1000;
export const COMPACTION_FRESH_BACKLOG_MIN_POINTS = 1024;
export const COMPACTION_URGENT_BACKLOG_MIN_POINTS = 2048;

export function nextCompactionPointLimit(
	current: number,
	durationMs: number,
	minimum = COMPACTION_BATCH_MIN_POINTS
): number {
	const boundedMinimum = Math.max(
		COMPACTION_BATCH_MIN_POINTS,
		Math.min(COMPACTION_BATCH_MAX_POINTS, Math.floor(minimum))
	);
	const boundedCurrent = Math.max(
		boundedMinimum,
		Math.min(COMPACTION_BATCH_MAX_POINTS, Math.floor(current))
	);
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		return boundedCurrent;
	}
	if (durationMs > COMPACTION_BATCH_TARGET_MS * 1.25) {
		const scaled = Math.floor(
			boundedCurrent *
				(COMPACTION_BATCH_TARGET_MS / durationMs) *
				0.8
		);
		return Math.max(
			boundedMinimum,
			Math.min(boundedCurrent - 1, scaled)
		);
	}
	if (
		durationMs < COMPACTION_BATCH_TARGET_MS * 0.5 &&
		boundedCurrent < COMPACTION_BATCH_MAX_POINTS
	) {
		return Math.min(
			COMPACTION_BATCH_MAX_POINTS,
			Math.max(
				boundedCurrent + 1,
				Math.ceil(boundedCurrent * 1.25)
			)
		);
	}
	return boundedCurrent;
}

export function compactionPointFloor(options: {
	backlogAgeMs: number;
	recentQueryAgeMs: number;
}): number {
	if (options.recentQueryAgeMs <= COMPACTION_QUERY_ACTIVITY_WINDOW_MS) {
		return COMPACTION_BATCH_MIN_POINTS;
	}
	if (options.backlogAgeMs >= COMPACTION_URGENT_BACKLOG_AGE_MS) {
		return COMPACTION_URGENT_BACKLOG_MIN_POINTS;
	}
	if (options.backlogAgeMs >= COMPACTION_FRESH_BACKLOG_AGE_MS) {
		return COMPACTION_FRESH_BACKLOG_MIN_POINTS;
	}
	return COMPACTION_BATCH_MIN_POINTS;
}

export function compactionPauseMs(options: {
	backlogAgeMs: number;
	recentQueryAgeMs: number;
	recentQueryQueueWaitMs: number;
}): number {
	if (options.recentQueryAgeMs <= COMPACTION_QUERY_ACTIVITY_WINDOW_MS) {
		return options.recentQueryQueueWaitMs > 100
			? COMPACTION_PRESSURED_PAUSE_MS
			: COMPACTION_ACTIVE_PAUSE_MS;
	}
	if (options.backlogAgeMs >= COMPACTION_URGENT_BACKLOG_AGE_MS) {
		return COMPACTION_URGENT_PAUSE_MS;
	}
	if (options.backlogAgeMs >= COMPACTION_FRESH_BACKLOG_AGE_MS) {
		return COMPACTION_FRESH_PAUSE_MS;
	}
	return COMPACTION_BATCH_PAUSE_MS;
}
