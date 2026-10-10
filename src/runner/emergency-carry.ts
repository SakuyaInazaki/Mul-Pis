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
export type CampaignCarrySeal =
	Readonly<{ mode: "normal"; carry: SealResult }> |
	Readonly<{ mode: "emergency-effects-unreviewed"; carry: SealResult;
		/** Process-only original exception for private, redacted diagnosis. */
		normalFailure?: unknown;
		forcedReason?: "research-collection-incomplete" }>;

/** Retains both process-only causes when neither seal succeeds. The public
 * message is static; callers must redact before private persistence. */
export class CampaignCarryRecoveryError extends HarnessError {
	readonly normalFailure: unknown;
	readonly emergencyFailure: unknown;
	readonly forcedReason?: "research-collection-incomplete";
	constructor(emergencyFailure: unknown, normalFailure?: unknown,
		forcedReason?: "research-collection-incomplete") {
		super("runner.emergency-carry", "emergency continuation sealing failed");
		this.normalFailure = normalFailure;
		this.emergencyFailure = emergencyFailure;
		this.forcedReason = forcedReason;
	}
}

/** The exact same audited observation must reach both paths. A failed normal
 * attempt may not edit the audit or change the current fees before fallback. */
export function sealCampaignCarry(ledger: EmergencyCarrySealer,
	input: AccountingCarrySealInput,
	options?: Readonly<{ forceEmergencyReason: "research-collection-incomplete" }>): CampaignCarrySeal {
	const before = JSON.stringify(input);
	if (options?.forceEmergencyReason === "research-collection-incomplete") {
		try { return { mode: "emergency-effects-unreviewed", forcedReason: options.forceEmergencyReason,
			carry: ledger.sealEmergencyCurrent(input, "effect-review-incomplete") }; }
		catch (emergencyFailure) { throw new CampaignCarryRecoveryError(emergencyFailure,
			undefined, options.forceEmergencyReason); }
	}
	try {
		return { mode: "normal", carry: ledger.sealCurrent(input) };
	} catch (normalFailure) {
		if (JSON.stringify(input) !== before)
			throw new HarnessError("runner.emergency-carry", "normal sealing changed the audited observation");
		try { return { mode: "emergency-effects-unreviewed",
			carry: ledger.sealEmergencyCurrent(input, "effect-review-incomplete"), normalFailure }; }
		catch (emergencyFailure) {
			throw new CampaignCarryRecoveryError(emergencyFailure, normalFailure);
		}
	}
}
