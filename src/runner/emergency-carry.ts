import { HarnessError } from "../types.ts";
import type { AccountingCarrySealInput, LedgerContinuation } from "./ledger-continuation.ts";

type SealResult = ReturnType<LedgerContinuation["sealCurrent"]>;
/** The emergency sealer belongs to the authenticated ledger and must perform its
 * own accounting checks. This wrapper only prevents a failed normal scientific
 * seal from being represented as a successful normal carry. */
export type EmergencyCarrySealer = {
	sealCurrent: (input: AccountingCarrySealInput) => SealResult;
	sealEmergencyCurrent: (input: AccountingCarrySealInput,
		reason: "effect-review-incomplete") => SealResult;
};
export type CampaignCarrySeal = Readonly<{
	mode: "normal" | "emergency-effects-unreviewed";
	carry: SealResult;
}>;

/** The exact same audited observation must reach both paths. A failed normal
 * attempt may not edit the audit or change the current fees before fallback. */
export function sealCampaignCarry(ledger: EmergencyCarrySealer,
	input: AccountingCarrySealInput): CampaignCarrySeal {
	const before = JSON.stringify(input);
	try {
		return { mode: "normal", carry: ledger.sealCurrent(input) };
	} catch {
		if (JSON.stringify(input) !== before)
			throw new HarnessError("runner.emergency-carry", "normal sealing changed the audited observation");
		return { mode: "emergency-effects-unreviewed",
			carry: ledger.sealEmergencyCurrent(input, "effect-review-incomplete") };
	}
}
