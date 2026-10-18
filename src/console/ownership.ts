/** Cross-process exclusion for one workspace's research mutations and console host. */
import { mkdir, open, readFile, readdir, realpath, lstat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { probeProcessIdentity, readCurrentProcessIdentity, type ProcessIdentityV1 } from "../runtime/process-identity.ts";
import { parseRunDescriptor } from "../runtime/run-descriptor.ts";

type Owner = { version: 1; kind: "console" | "mutation"; instanceId?: string; process: ProcessIdentityV1 };
const sameProcess = (a: ProcessIdentityV1, b: ProcessIdentityV1): boolean => a.hostId === b.hostId && a.bootId === b.bootId && a.pid === b.pid && a.processStartToken === b.processStartToken;
const ownerFile = (root: string): string => path.join(root, ".agent", "console", "owner.lock");
const ownerScope = new AsyncLocalStorage<ReadonlySet<string>>();
async function canonicalWorkspace(workspace: string): Promise<string> {
	let existing = path.resolve(workspace);
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		suffix.unshift(path.basename(existing)); existing = parent;
	}
	return path.join(await realpath(existing), ...suffix);
}

async function checkedOwner(file: string): Promise<{ owner: Owner; inode: { dev: number; ino: number } } | undefined> {
	let info;
	try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error("workspace console owner record is untrusted");
	let value: unknown;
	try { value = JSON.parse(await readFile(file, "utf8")); } catch { throw new Error("workspace console owner is unknown; manual review required"); }
	const owner = value as Partial<Owner>;
	if (owner.version !== 1 || !["console", "mutation"].includes(owner.kind ?? "") || !owner.process?.hostId || !owner.process.bootId || !owner.process.processStartToken || !Number.isSafeInteger(owner.process.pid) || (owner.kind === "console" && (!owner.instanceId || !/^[a-f0-9-]{36}$/.test(owner.instanceId)))) throw new Error("workspace console owner is unknown; manual review required");
	return { owner: owner as Owner, inode: { dev: info.dev, ino: info.ino } };
}

async function verifiedDead(root: string, owner: Owner): Promise<boolean> {
	const probe = await probeProcessIdentity(owner.process);
	if (probe.status !== "dead") return false;
	if (owner.kind === "mutation") return true;
	const descriptorFile = path.join(root, ".agent", "console", "instances", owner.instanceId!, "run-descriptor.json");
	let child: ProcessIdentityV1;
	try { child = parseRunDescriptor(JSON.parse(await readFile(descriptorFile, "utf8"))).process; }
	catch { return false; }
	return (await probeProcessIdentity(child)).status === "dead";
}

async function removeDeadOwner(root: string, file: string, found: { owner: Owner; inode: { dev: number; ino: number } }): Promise<boolean> {
	if (!await verifiedDead(root, found.owner)) return false;
	const after = await lstat(file).catch(() => undefined);
	if (!after || after.dev !== found.inode.dev || after.ino !== found.inode.ino) return false;
	await unlink(file);
	return true;
}

async function acquire(root: string, owner: Owner): Promise<() => Promise<void>> {
	const directory = path.join(root, ".agent", "console");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = ownerFile(root);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const handle = await open(file, "wx", 0o600);
			const inode = await handle.stat();
			try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); }
			catch (error) { await handle.close(); await unlink(file).catch(() => undefined); throw error; }
			let released = false;
			return async () => {
				if (released) return; released = true;
				await handle.close();
				const current = await lstat(file).catch(() => undefined);
				if (current && current.dev === inode.dev && current.ino === inode.ino) await unlink(file);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const found = await checkedOwner(file);
			if (!found) continue;
			if (!await removeDeadOwner(root, file, found)) throw new Error("workspace console already owned or owner unknown");
		}
	}
	throw new Error("workspace console owner changed during acquisition");
}

export async function acquireConsoleWorkspaceOwner(workspace: string, instanceId: string): Promise<() => Promise<void>> {
	const root = await canonicalWorkspace(workspace);
	if (!/^[a-f0-9-]{36}$/.test(instanceId)) throw new Error("invalid console instance id");
	const release = await acquire(root, { version: 1, kind: "console", instanceId, process: await readCurrentProcessIdentity() });
	try {
		await assertNoIndependentM07Attempt(root);
		return release;
	} catch (error) { await release(); throw error; }
}

async function assertNoIndependentM07Attempt(root: string): Promise<void> {
	const directory = path.join(root, "stages", "M07");
	let entries;
	try { entries = await readdir(directory, { withFileTypes: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new Error(`M07 run ${entry.name} is a symlink and cannot be checked`);
		if (!entry.isDirectory()) continue;
		const file = path.join(directory, entry.name, "goal.json");
		let goal: { lifecycle?: string; executionState?: { activeAttemptId?: string; attempts?: { id?: string; runDescriptor?: unknown }[] } };
		try { goal = JSON.parse(await readFile(file, "utf8")) as typeof goal; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error(`M07 goal ${entry.name} cannot be checked before console start`); }
		if (goal.lifecycle !== "active") continue;
		const activeId = goal.executionState?.activeAttemptId;
		const attempt = goal.executionState?.attempts?.find((item) => item.id === activeId);
		if (!activeId || !attempt?.runDescriptor) throw new Error(`active legacy M07 goal ${entry.name} has no verifiable process identity`);
		let descriptor;
		try { descriptor = parseRunDescriptor(attempt.runDescriptor); }
		catch { throw new Error(`active M07 goal ${entry.name} has an invalid attempt descriptor`); }
		const probe = await probeProcessIdentity(descriptor.process);
		if (probe.status !== "dead") throw new Error(`active M07 goal ${entry.name} may still have a running attempt: ${probe.reason}`);
	}
}

async function currentPiOwnsConsole(root: string, owner: Owner): Promise<boolean> {
	if (owner.kind !== "console") return false;
	if ((await probeProcessIdentity(owner.process)).status !== "alive") return false;
	const controlDir = path.join(root, ".agent", "console", "instances", owner.instanceId!);
	const descriptorFile = path.join(controlDir, "run-descriptor.json");
	if (process.env.MUL_PIS_CONSOLE_CONTROL_DIR !== controlDir || process.env.PRE_RSI_RUN_DESCRIPTOR_FILE !== descriptorFile || process.env.PRE_RSI_RUN_INSTANCE_ID !== owner.instanceId) return false;
	const dir = await lstat(controlDir).catch(() => undefined);
	const file = await lstat(descriptorFile).catch(() => undefined);
	if (!dir?.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0 || !file?.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) return false;
	try {
		const descriptor = parseRunDescriptor(JSON.parse(await readFile(descriptorFile, "utf8")));
		const current = await readCurrentProcessIdentity();
		return descriptor.controlDir === controlDir && descriptor.instanceId === owner.instanceId && descriptor.processGroupId === current.pid && sameProcess(descriptor.process, current);
	} catch { return false; }
}

/** Wrap ResearchService.withMutation so a standalone CLI cannot race a console Pi. */
export async function withWorkspaceMutationOwnership<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
	const root = await canonicalWorkspace(workspace);
	const inherited = ownerScope.getStore();
	if (inherited?.has(root)) return operation();
	const run = (): Promise<T> => ownerScope.run(new Set([...(inherited ?? []), root]), operation);
	const file = ownerFile(root);
	const found = await checkedOwner(file);
	if (found && await currentPiOwnsConsole(root, found.owner)) return run();
	if (found) {
		if (!await removeDeadOwner(root, file, found)) throw new Error("workspace console already owned or owner unknown");
	}
	const release = await acquire(root, { version: 1, kind: "mutation", process: await readCurrentProcessIdentity() });
	try { return await run(); } finally { await release(); }
}
