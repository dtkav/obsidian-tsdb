export const STARTUP_COMPACTION_DELAY_MS = 5 * 60 * 1000;
export const COMPACTION_SWEEP_MS = 6 * 60 * 60 * 1000;
export const COMPACTION_BACKLOG_RETRY_MS = 1000;
export const COMPACTION_BATCH_MIN_POINTS = 64;
export const COMPACTION_BATCH_MAX_POINTS = 512;
export const COMPACTION_BATCH_TARGET_MS = 50;
export const COMPACTION_MAX_BATCHES_PER_SWEEP = 16;
export const COMPACTION_BATCH_PAUSE_MS = 500;
export const COMPACTION_URGENT_PAUSE_MS = 250;
export const COMPACTION_ACTIVE_PAUSE_MS = 750;
export const COMPACTION_PRESSURED_PAUSE_MS = 1000;
export const COMPACTION_QUERY_ACTIVITY_WINDOW_MS = 3000;
export const COMPACTION_URGENT_BACKLOG_AGE_MS = 7 * 60 * 60 * 1000;
export const COMPACTION_FRESH_BACKLOG_AGE_MS = 4 * 60 * 60 * 1000;
export const COMPACTION_FRESH_BACKLOG_MIN_POINTS = 256;
export const COMPACTION_URGENT_BACKLOG_MIN_POINTS = 512;

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
		return 400;
	}
	return COMPACTION_BATCH_PAUSE_MS;
}
