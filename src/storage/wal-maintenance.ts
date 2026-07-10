import { MetricsStore } from "./store";
import { SampleWal, WalReplayResult } from "./wal";

export type StartupWalMaintenanceResult =
	| {
			mode: "checkpoint";
			samples: 0;
			batches: 0;
			bytes: 0;
			aborted: false;
	  }
	| ({ mode: "replay" } & WalReplayResult);

export interface StartupWalMaintenanceOptions {
	shouldContinue?: () => boolean;
}

export async function maintainStartupWal(
	wal: SampleWal,
	store: MetricsStore,
	options: StartupWalMaintenanceOptions = {}
): Promise<StartupWalMaintenanceResult> {
	if (!store.recoveredFromCorruption) {
		await wal.truncate();
		return {
			mode: "checkpoint",
			samples: 0,
			batches: 0,
			bytes: 0,
			aborted: false,
		};
	}

	const result = await wal.replayIntoWithStats(store, {
		shouldContinue: options.shouldContinue,
	});
	if (!result.aborted) {
		await wal.barrier();
		await wal.truncate();
	}
	return { mode: "replay", ...result };
}
