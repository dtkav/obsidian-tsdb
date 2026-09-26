// Vacuum pacing. Like compaction, a vacuum batch is mostly fixed cost, so
// the page limit moves within a band whose floor still reclaims space
// faster than retention frees it.
export const VACUUM_BATCH_MIN_PAGES = 64;
export const VACUUM_BATCH_MAX_PAGES = 1024;
export const VACUUM_BATCH_INITIAL_PAGES = 256;
export const VACUUM_BATCH_TARGET_MS = 250;
export const VACUUM_BATCH_PAUSE_MS = 250;
export const VACUUM_MAX_BATCHES_PER_SWEEP = 16;
export const VACUUM_SWEEP_PAUSE_MS = 5000;

export function nextVacuumPageLimit(
	current: number,
	durationMs: number
): number {
	if (!Number.isFinite(durationMs) || durationMs <= 0) return current;
	if (durationMs > VACUUM_BATCH_TARGET_MS * 1.25) {
		const scaled = Math.floor(
			current * (VACUUM_BATCH_TARGET_MS / durationMs) * 0.8
		);
		return Math.max(
			VACUUM_BATCH_MIN_PAGES,
			Math.min(current - 1, scaled)
		);
	}
	if (
		durationMs < VACUUM_BATCH_TARGET_MS * 0.5 &&
		current < VACUUM_BATCH_MAX_PAGES
	) {
		return Math.min(
			VACUUM_BATCH_MAX_PAGES,
			Math.max(current + 1, Math.ceil(current * 1.25))
		);
	}
	return current;
}
