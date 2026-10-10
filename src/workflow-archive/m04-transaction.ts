/** Portable private M04 transaction evidence for encrypted continuation only.
 * This packages exact host draft and validation receipt bytes without granting
 * authority to replay a proposal or treating a draft as published knowledge.
 */
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../workspace.ts";
import type { M04KnowledgeTransactionV1 } from "../stages/m04.ts";

const FILE_BOUND = 1_000_000;
const BUNDLE_FILE_BOUND = 4 * 1024 * 1024;
type Attempt = M04KnowledgeTransactionV1["attempts"][number];
export type PortableM04KnowledgeTransactionV1 = Omit<M04KnowledgeTransactionV1, "attempts"> & {
	attempts: Array<Attempt & { proposalDraftJson: string; validationReceiptJson: string }>;
};

function reject(reason: string): never { throw new Error(`private M04 transaction: ${reason}`); }
function object(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function boundedText(file: string, root: string): Promise<string> {
	const parent = await realpath(root);
	const actual = await realpath(file);
	if (!actual.startsWith(`${parent}${path.sep}`)) reject("transaction evidence escapes its host root");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_BOUND)
		reject("transaction evidence is not a bounded regular file");
	const bytes = await readFile(file);
	if (bytes.length > FILE_BOUND || bytes.length !== info.size)
		reject("transaction evidence changed size");
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { return reject("transaction evidence is not valid UTF-8 text"); }
}

/** Called before ephemeral workspace cleanup. All content remains in the
 * confidential result/carry; the archive only identifies a rejected draft. */
export async function exportPortableM04Transaction(input: {
	ws: Workspace; m04RunId: string; destination: string;
}): Promise<PortableM04KnowledgeTransactionV1> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.m04RunId)) reject("run identity is invalid");
	const runDir = input.ws.runDir("M04", input.m04RunId);
	const rawText = await boundedText(path.join(runDir, "m04-transaction.json"), runDir);
	let parsed: unknown;
	try { parsed = JSON.parse(rawText); } catch { return reject("host transaction JSON is invalid"); }
	if (!object(parsed) || parsed.version !== 1 || parsed.kind !== "m04-knowledge-transaction" ||
		parsed.m04RunId !== input.m04RunId || !Array.isArray(parsed.attempts) ||
		!["no-proposal", "rejected-draft", "merge-intent", "merged", "unknown"].includes(String(parsed.state)))
		reject("host transaction state is invalid");
	const tx = parsed as unknown as M04KnowledgeTransactionV1;
	const attempts: PortableM04KnowledgeTransactionV1["attempts"] = [];
	for (const [index, attempt] of tx.attempts.entries()) {
		const ordinal = index + 1;
		if (!object(attempt) || attempt.ordinal !== ordinal ||
			!/^P\d{4,}$/.test(String(attempt.proposalId)) ||
			attempt.receiptFile !== `proposal-validation-${String(ordinal).padStart(4, "0")}.json` ||
			attempt.proposalFile !== path.relative(input.ws.root,
				path.join(input.ws.knowledgeDir, "proposals", `${attempt.proposalId}.json`)).replaceAll("\\", "/") ||
			typeof attempt.structurallyValid !== "boolean" || !Array.isArray(attempt.issues))
			reject("host transaction attempt is invalid");
		const proposalDraftJson = await boundedText(path.join(input.ws.knowledgeDir, "proposals",
			`${attempt.proposalId}.json`), path.join(input.ws.knowledgeDir, "proposals"));
		const validationReceiptJson = await boundedText(path.join(runDir, attempt.receiptFile), runDir);
		let draft: unknown, receipt: unknown;
		try { draft = JSON.parse(proposalDraftJson); receipt = JSON.parse(validationReceiptJson); }
		catch { return reject("proposal draft or receipt JSON is invalid"); }
		if (!object(draft) || draft.id !== attempt.proposalId || draft.stage !== "M04" ||
			draft.runId !== input.m04RunId || !object(receipt) || receipt.version !== 1 ||
			receipt.kind !== "m04-proposal-validation" || receipt.m04RunId !== input.m04RunId ||
			receipt.proposalId !== attempt.proposalId || receipt.proposalFile !== attempt.proposalFile ||
			receipt.structurallyValid !== attempt.structurallyValid ||
			JSON.stringify(receipt.issues) !== JSON.stringify(attempt.issues))
			reject("proposal draft and validation receipt do not bind");
		attempts.push({ ...attempt, proposalDraftJson, validationReceiptJson });
	}
	const last = attempts.at(-1);
	if (attempts.slice(0, -1).some(item => item.state !== "rejected-draft" ||
		item.structurallyValid !== false ||
		!item.issues.some(issue => issue.level === "error")) ||
		(tx.state === "rejected-draft" && last &&
			!last.issues.some(issue => issue.level === "error")))
		reject("host transaction has an unaccounted earlier proposal state");
	if ((tx.state === "no-proposal" && attempts.length !== 0) ||
		(tx.state === "rejected-draft" && (!last || last.state !== "rejected-draft" ||
			last.structurallyValid !== false || tx.currentProposalId !== last.proposalId)) ||
		(tx.state === "merge-intent" && (!last || last.state !== "merge-intent" ||
			last.structurallyValid !== true || tx.currentProposalId !== last.proposalId)) ||
		(tx.state === "merged" && (!last || last.state !== "merged" ||
			last.structurallyValid !== true || tx.currentProposalId !== last.proposalId ||
			typeof tx.snapshotId !== "string" || !tx.snapshotId)) ||
		(tx.state !== "merged" && tx.snapshotId !== undefined))
		reject("host transaction state and attempts disagree");
	const portable: PortableM04KnowledgeTransactionV1 = { ...tx, attempts };
	const bytes = `${JSON.stringify(portable, null, 2)}\n`;
	if (Buffer.byteLength(bytes, "utf8") > BUNDLE_FILE_BOUND)
		reject("portable transaction exceeds private bundle file bound");
	const target = path.join(input.destination, "m04-transaction.json");
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, bytes, { mode: 0o600 });
	await rename(temporary, target);
	return portable;
}
