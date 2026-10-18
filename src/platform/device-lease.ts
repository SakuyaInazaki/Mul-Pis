/**
 * Exclusive, cross-process lease on the accelerator.
 *
 * Two candidates measured at the same time on one device produce timings that
 * cannot be compared and, often enough, an out-of-memory failure charged to
 * whichever candidate happened to run second. The lease serialises exactly the
 * commands that touch the device, leaves everything else parallel, and records
 * who holds it with a full process identity so a crashed holder can be proven
 * dead instead of being waited on forever.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";
import { probeProcessIdentity, readCurrentProcessIdentity, type ProcessIdentityV1 } from "../runtime/process-identity.ts";

export interface DeviceLeaseRecordV1 {
	version: 1;
	owner: ProcessIdentityV1;
	platformId: string;
	acquiredAt: string;
	/** Bounded description of the work holding the device; never full command text. */
	purpose: string;
}

export interface DeviceLeaseHandle {
	record: DeviceLeaseRecordV1;
	release(): Promise<void>;
}

export interface DeviceLeaseOptions {
	file: string;
	platformId: string;
	purpose: string;
	/** Total time to wait for a live holder before giving up. */
	timeoutMs: number;
	pollMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 100;

function parse(text: string): DeviceLeaseRecordV1 | undefined {
	try {
		const value = JSON.parse(text) as Partial<DeviceLeaseRecordV1>;
		if (value?.version !== 1 || !value.owner || typeof value.platformId !== "string") return undefined;
		return value as DeviceLeaseRecordV1;
	} catch {
		return undefined;
	}
}

async function readHolder(file: string): Promise<DeviceLeaseRecordV1 | undefined> {
	try {
		return parse(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Take the device, or wait. A holder is displaced only when its process is
 * proven dead on this host and boot; an unknown holder keeps the device, because
 * guessing wrong here means two processes measuring at once.
 */
export async function acquireDeviceLease(options: DeviceLeaseOptions): Promise<DeviceLeaseHandle> {
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
	const identity = await readCurrentProcessIdentity();
	const deadline = now() + options.timeoutMs;
	await mkdir(path.dirname(options.file), { recursive: true });
	for (;;) {
		const record: DeviceLeaseRecordV1 = { version: 1, owner: identity, platformId: options.platformId,
			acquiredAt: new Date(now()).toISOString(), purpose: options.purpose.slice(0, 200) };
		try {
			// Exclusive create is the whole protocol: whoever creates the file owns
			// the device until it is removed.
			await writeFile(options.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
			return { record, release: async () => { await releaseDeviceLease(options.file, identity); } };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const holder = await readHolder(options.file);
		if (holder) {
			const probe = await probeProcessIdentity(holder.owner);
			// A dead owner on this host and boot cannot still be measuring. An
			// unknown owner keeps the device: taking it from a live process would
			// corrupt both measurements.
			if (probe.status === "dead") {
				await rm(options.file, { force: true });
				continue;
			}
		}
		if (now() >= deadline)
			throw new HarnessError("platform.device-lease",
				`device for platform ${options.platformId} is held by ${holder ? `pid ${holder.owner.pid} (${holder.purpose})` : "an unreadable lease"}; waited ${options.timeoutMs} ms`);
		await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
	}
}

/** Release only our own lease; a lease taken over after a crash is not ours. */
export async function releaseDeviceLease(file: string, identity: ProcessIdentityV1): Promise<void> {
	const holder = await readHolder(file);
	if (!holder) return;
	if (holder.owner.pid !== identity.pid || holder.owner.processStartToken !== identity.processStartToken) return;
	await rm(file, { force: true });
}

export async function readDeviceLease(file: string): Promise<DeviceLeaseRecordV1 | undefined> {
	return readHolder(file);
}
