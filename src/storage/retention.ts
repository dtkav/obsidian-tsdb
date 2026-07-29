/**
 * Retention deletes complete compressed blocks. A block contains at most
 * 2,048 samples, so this limit keeps one transaction near one block instead
 * of allowing the previous 100,000-sample startup transaction.
 */
export const RETENTION_BATCH_MAX_SAMPLES = 2_048;

/** Leave foreground work a substantial scheduling window between deletes. */
export const RETENTION_BATCH_PAUSE_MS = 250;

/** Yield once between independent retention finalization phases. */
export const RETENTION_FINALIZE_PAUSE_MS = 250;
