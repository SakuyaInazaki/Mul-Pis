/** One source for the harness revision recorded on local mission attempts.
 *
 * Two numbers may only be compared when they came from the same harness: the
 * review basis treats the harness itself as an experiment variable, so a
 * literal constant in an attempt record silently makes incomparable runs look
 * comparable. The value follows the same rule as a versioned M07 goal: the
 * verified loaded-source commit when there is one, the explicitly configured
 * revision otherwise, and `unrecorded` when neither exists. */
import { verifyLoadedSource } from "../runtime/loaded-source.ts";

/** Attempt records written before the revision was resolved from the loaded
 * source carry this literal. It only recognizes old records; nothing new
 * should be written with it. */
export const LEGACY_LOCAL_HARNESS_REVISION = "local-harness-v1";

const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function harnessCodeRevision(): Promise<string> {
	const loaded = await verifyLoadedSource(import.meta.url);
	const revision = loaded?.sourceCommit ?? process.env.PRE_RSI_CODE_REVISION ?? "unrecorded";
	// An unusable value must not silently become a different one: attempt records
	// are compared byte for byte by the host.
	return SAFE_REVISION.test(revision) ? revision : "unrecorded";
}
