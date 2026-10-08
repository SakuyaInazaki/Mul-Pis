/** Repartition an existing encrypted Actions artifact ZIP as opaque bytes.
 * No ZIP member is opened, interpreted, or decrypted here. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPAQUE_ARCHIVE_CHUNK_BYTES = 16 * 1024 * 1024;
export const OPAQUE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const OPAQUE_MANIFEST_FILE = "opaque-archive-repartition.json";
export const OPAQUE_SOURCE_ARTIFACT_NAME = "confidential-campaign-envelope";
export const OPAQUE_REQUEST_FILE = "opaque-repartition-request.json";
const REPOSITORY = "SakuyaInazaki/Mul-Pis";
const SOURCE_HEAD_BRANCH = "run-requests/workflow-learning-reliability";
const SOURCE_WORKFLOW_PATH = ".github/workflows/manual-private-campaign.yml";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]{0,17}$/;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export type OpaqueArchiveRequest = Readonly<{
	version: 1; kind: "mul-pis-opaque-archive-repartition-request";
	repository: typeof REPOSITORY; sourceRunId: string; sourceArtifactId: string;
	sourceCommit: string; sourceArtifactName: typeof OPAQUE_SOURCE_ARTIFACT_NAME;
	archiveBytes: number; archiveSha256: string;
}>;
export type OpaqueArchivePart = Readonly<{
	index: number; artifactName: string; fileName: string;
	bytes: number; sha256: string; artifactId: string; archiveSha256: string;
}>;
export type OpaqueArchiveManifest = Readonly<{
	version: 1; kind: "mul-pis-opaque-actions-archive-repartition";
	request: OpaqueArchiveRequest;
	transport: Readonly<{ runId: string; runAttempt: number; commit: string }>;
	chunkBytes: number;
	parts: readonly OpaqueArchivePart[];
}>;
type ArtifactClient = {
	uploadArtifact(name: string, files: string[], rootDirectory: string,
		options: { retentionDays: number }): Promise<unknown>;
};
type TransportSource = Readonly<{ runId: string; runAttempt: number; commit: string }>;

function fail(reason: string): never { throw new Error(`opaque artifact repartition: ${reason}`); }
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function positiveId(value: unknown): value is string {
	return typeof value === "string" && ID.test(value);
}
function canonicalDigest(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const raw = value.startsWith("sha256:") ? value.slice(7) : value;
	return HEX64.test(raw) && (value === raw || value === `sha256:${raw}`) ? raw : undefined;
}
function validTransport(value: unknown): value is TransportSource {
	return record(value) && exact(value, ["runId", "runAttempt", "commit"]) &&
		positiveId(value.runId) && Number.isSafeInteger(value.runAttempt) &&
		Number(value.runAttempt) > 0 && typeof value.commit === "string" && HEX40.test(value.commit);
}

export function parseOpaqueArchiveRequest(raw: string): OpaqueArchiveRequest {
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return fail("request JSON is invalid"); }
	if (!record(value) || !exact(value, ["version", "kind", "repository", "sourceRunId",
		"sourceArtifactId", "sourceCommit", "sourceArtifactName", "archiveBytes", "archiveSha256"]) ||
		value.version !== 1 || value.kind !== "mul-pis-opaque-archive-repartition-request" ||
		value.repository !== REPOSITORY || !positiveId(value.sourceRunId) ||
		!positiveId(value.sourceArtifactId) || typeof value.sourceCommit !== "string" ||
		!HEX40.test(value.sourceCommit) || value.sourceArtifactName !== OPAQUE_SOURCE_ARTIFACT_NAME ||
		!Number.isSafeInteger(value.archiveBytes) || Number(value.archiveBytes) < 1 ||
		Number(value.archiveBytes) > OPAQUE_ARCHIVE_MAX_BYTES ||
		typeof value.archiveSha256 !== "string" || !HEX64.test(value.archiveSha256))
		fail("request fields are invalid");
	return value as OpaqueArchiveRequest;
}

export function opaquePartName(rootName: string, index: number): string {
	if (!/^confidential-opaque-archive-[1-9][0-9-]*$/.test(rootName) ||
		!Number.isSafeInteger(index) || index < 0 || index >=
		Math.ceil(OPAQUE_ARCHIVE_MAX_BYTES / OPAQUE_ARCHIVE_CHUNK_BYTES))
		fail("part identity is invalid");
	return `${rootName}-part-${String(index).padStart(8, "0")}`;
}
export function opaquePartFile(index: number): string {
	if (!Number.isSafeInteger(index) || index < 0 || index >=
		Math.ceil(OPAQUE_ARCHIVE_MAX_BYTES / OPAQUE_ARCHIVE_CHUNK_BYTES))
		fail("part index is invalid");
	return `opaque-archive.part-${String(index).padStart(8, "0")}.bin`;
}
export function opaqueRootName(input: OpaqueArchiveRequest, transport: TransportSource): string {
	if (!validTransport(transport)) fail("transport source is invalid");
	return `confidential-opaque-archive-${input.sourceRunId}-${input.sourceArtifactId}-` +
		`${transport.runId}-${transport.runAttempt}`;
}

export function splitOpaqueArchive(input: Readonly<{ request: OpaqueArchiveRequest;
	transport: TransportSource; archive: Buffer; chunkBytes?: number }>): Readonly<{
	rootName: string;
	parts: readonly Readonly<{ index: number; artifactName: string; fileName: string;
		bytes: Buffer; sha256: string }>[];
}> {
	const request = parseOpaqueArchiveRequest(JSON.stringify(input.request));
	if (!Buffer.isBuffer(input.archive) || input.archive.length !== request.archiveBytes ||
		sha256(input.archive) !== request.archiveSha256) fail("original archive length or SHA-256 differs");
	const chunkBytes = input.chunkBytes ?? OPAQUE_ARCHIVE_CHUNK_BYTES;
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > OPAQUE_ARCHIVE_CHUNK_BYTES)
		fail("chunk size is invalid");
	const rootName = opaqueRootName(request, input.transport);
	const parts = [];
	for (let start = 0, index = 0; start < input.archive.length; start += chunkBytes, index++) {
		const bytes = input.archive.subarray(start, Math.min(input.archive.length, start + chunkBytes));
		parts.push({ index, artifactName: opaquePartName(rootName, index),
			fileName: opaquePartFile(index), bytes, sha256: sha256(bytes) });
	}
	if (parts.length > 8) fail("archive needs too many chunks");
	return { rootName, parts };
}

export function validateOpaqueArchiveManifest(value: unknown,
	request: OpaqueArchiveRequest, transport: TransportSource): value is OpaqueArchiveManifest {
	const requestFields = ["version", "kind", "repository", "sourceRunId", "sourceArtifactId",
		"sourceCommit", "sourceArtifactName", "archiveBytes", "archiveSha256"] as const;
	const transportFields = ["runId", "runAttempt", "commit"] as const;
	if (!record(value) || !exact(value, ["version", "kind", "request", "transport",
		"chunkBytes", "parts"]) || value.version !== 1 ||
		value.kind !== "mul-pis-opaque-actions-archive-repartition" ||
		!record(value.request) || !exact(value.request, requestFields) ||
		!requestFields.every(key => (value.request as Record<string, unknown>)[key] === request[key]) ||
		!validTransport(transport) || !record(value.transport) ||
		!exact(value.transport, transportFields) ||
		!transportFields.every(key => (value.transport as Record<string, unknown>)[key] === transport[key]) ||
		!Number.isSafeInteger(value.chunkBytes) || Number(value.chunkBytes) < 1 ||
		Number(value.chunkBytes) > OPAQUE_ARCHIVE_CHUNK_BYTES ||
		!Array.isArray(value.parts) || value.parts.length !==
		Math.ceil(request.archiveBytes / Number(value.chunkBytes))) return false;
	const rootName = opaqueRootName(request, transport);
	const ids = new Set<string>();
	for (let index = 0; index < value.parts.length; index++) {
		const part = value.parts[index];
		if (!record(part) || !exact(part, ["index", "artifactName", "fileName", "bytes",
			"sha256", "artifactId", "archiveSha256"]) || part.index !== index ||
			part.artifactName !== opaquePartName(rootName, index) ||
			part.fileName !== opaquePartFile(index) ||
			part.bytes !== Math.min(Number(value.chunkBytes), request.archiveBytes -
				index * Number(value.chunkBytes)) ||
			typeof part.sha256 !== "string" || !HEX64.test(part.sha256) ||
			!positiveId(part.artifactId) || ids.has(part.artifactId) ||
			typeof part.archiveSha256 !== "string" || !HEX64.test(part.archiveSha256)) return false;
		ids.add(part.artifactId);
	}
	return true;
}

/** A later connector supplies measured ZIP SHA-256 and extracted member bytes. */
export function restoreOpaqueArchive(input: Readonly<{ manifest: OpaqueArchiveManifest;
	parts: readonly Readonly<{ artifactId: string; archiveSha256: string; bytes: Buffer }>[];
}>): Buffer {
	const { manifest } = input;
	if (!validateOpaqueArchiveManifest(manifest, manifest.request, manifest.transport) ||
		input.parts.length !== manifest.parts.length) fail("repartition manifest is invalid");
	const buffers: Buffer[] = [];
	for (let index = 0; index < manifest.parts.length; index++) {
		const expected = manifest.parts[index]!;
		const observed = input.parts[index]!;
		if (observed.artifactId !== expected.artifactId ||
			observed.archiveSha256 !== expected.archiveSha256 ||
			!Buffer.isBuffer(observed.bytes) || observed.bytes.length !== expected.bytes ||
			sha256(observed.bytes) !== expected.sha256)
			fail("repartition part identity or bytes differ");
		buffers.push(observed.bytes);
	}
	const archive = Buffer.concat(buffers, manifest.request.archiveBytes);
	if (archive.length !== manifest.request.archiveBytes ||
		sha256(archive) !== manifest.request.archiveSha256)
		fail("restored original archive differs");
	return archive;
}

const API = `https://api.github.com/repos/${REPOSITORY}`;
const HEADER_TIMEOUT_MS = 15_000;
const BODY_IDLE_TIMEOUT_MS = 15_000;
function allowedArtifactRedirect(value: string | null): string {
	let url: URL;
	try { url = new URL(value ?? ""); } catch { return fail("artifact redirect is invalid"); }
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || url.username || url.password ||
		(url.port && url.port !== "443") || !(
		host === "objects.githubusercontent.com" ||
		host.endsWith(".blob.core.windows.net") ||
		/^.+\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(host)))
		fail("artifact redirect host is untrusted");
	return url.toString();
}
async function boundedResponse(response: Response, maxBytes: number,
	abort?: AbortController): Promise<Buffer> {
	if (!response.body) fail("HTTP response has no body");
	const claimed = response.headers.get("content-length");
	if (claimed !== null && (!/^[0-9]+$/.test(claimed) || Number(claimed) > maxBytes))
		fail("HTTP response length exceeds bound");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (true) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const read = reader.read();
			const result = await Promise.race([read, new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					abort?.abort();
					void reader.cancel().catch(() => undefined);
					reject(new Error("opaque artifact repartition: HTTP body stalled"));
				}, BODY_IDLE_TIMEOUT_MS);
			})]).finally(() => clearTimeout(timer));
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) { abort?.abort(); fail("HTTP response exceeds byte bound"); }
			chunks.push(Buffer.from(result.value));
		}
	} finally { reader.releaseLock(); }
	return Buffer.concat(chunks, total);
}
async function getWithHeaders(url: string, token: string | undefined,
	request: typeof fetch, redirect: RequestInit["redirect"]): Promise<{ response: Response;
	abort: AbortController }> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), HEADER_TIMEOUT_MS);
	try {
		const response = await request(url, { method: "GET", redirect, signal: abort.signal,
			headers: token ? { Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json" } : undefined });
		return { response, abort };
	} finally { clearTimeout(timer); }
}
async function githubObject(url: string, token: string,
	request: typeof fetch): Promise<Record<string, unknown>> {
	const { response, abort } = await getWithHeaders(url, token, request, "error");
	if (response.status !== 200) fail("GitHub metadata read was not accepted");
	let value: unknown;
	try { value = JSON.parse((await boundedResponse(response, 1024 * 1024, abort)).toString("utf8")); }
	catch { return fail("GitHub metadata is invalid"); }
	if (!record(value)) fail("GitHub metadata is invalid");
	return value;
}

export async function downloadVerifiedOpaqueArchive(input: Readonly<{
	request: OpaqueArchiveRequest; githubToken: string; http?: typeof fetch;
}>): Promise<Buffer> {
	const expected = parseOpaqueArchiveRequest(JSON.stringify(input.request));
	if (typeof input.githubToken !== "string" || !input.githubToken ||
		input.githubToken.length > 4_000) fail("GitHub read token is unavailable");
	const http = input.http ?? fetch;
	const run = await githubObject(`${API}/actions/runs/${expected.sourceRunId}`,
		input.githubToken, http);
	if (run.id !== Number(expected.sourceRunId) || run.head_sha !== expected.sourceCommit ||
		run.head_branch !== SOURCE_HEAD_BRANCH || run.path !== SOURCE_WORKFLOW_PATH ||
		run.event !== "push" || run.status !== "completed" ||
		run.conclusion !== "cancelled" || run.run_attempt !== 1)
		fail("source workflow identity differs");
	const artifact = await githubObject(`${API}/actions/artifacts/${expected.sourceArtifactId}`,
		input.githubToken, http);
	const workflow = artifact.workflow_run;
	if (artifact.id !== Number(expected.sourceArtifactId) ||
		artifact.name !== expected.sourceArtifactName || artifact.expired !== false ||
		!record(workflow) || workflow.id !== Number(expected.sourceRunId) ||
		workflow.head_sha !== expected.sourceCommit ||
		(artifact.digest !== undefined &&
			canonicalDigest(artifact.digest) !== expected.archiveSha256))
		fail("source artifact identity differs");
	const url = `${API}/actions/artifacts/${expected.sourceArtifactId}/zip`;
	const first = await getWithHeaders(url, input.githubToken, http, "manual");
	let body = first;
	if ([301, 302, 303, 307, 308].includes(first.response.status)) {
		const redirected = allowedArtifactRedirect(first.response.headers.get("location"));
		first.abort.abort();
		body = await getWithHeaders(redirected, undefined, http, "error");
	}
	if (body.response.status !== 200) fail("source artifact download was not accepted");
	const bytes = await boundedResponse(body.response, expected.archiveBytes, body.abort);
	if (bytes.length !== expected.archiveBytes || sha256(bytes) !== expected.archiveSha256)
		fail("source artifact archive length or SHA-256 differs");
	return bytes;
}

function uploadedIdentity(value: unknown): Readonly<{ artifactId: string;
	archiveSha256: string }> {
	if (!record(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1)
		fail("uploaded part identity is missing");
	const digest = canonicalDigest(value.digest);
	if (!digest) fail("uploaded part archive digest is missing");
	return { artifactId: String(value.id), archiveSha256: digest };
}

export async function runOpaqueArchiveRepartition(input: Readonly<{
	request: OpaqueArchiveRequest; githubToken: string; transport: TransportSource;
	temporaryParent: string; client: ArtifactClient; http?: typeof fetch;
	/** Small offline fixtures only. Production always uses 16 MiB. */
	chunkBytes?: number;
}>): Promise<OpaqueArchiveManifest> {
	const request = parseOpaqueArchiveRequest(JSON.stringify(input.request));
	if (!validTransport(input.transport) || !path.isAbsolute(input.temporaryParent))
		fail("repartition execution source or temporary parent is invalid");
	const original = await downloadVerifiedOpaqueArchive({ request,
		githubToken: input.githubToken, ...(input.http ? { http: input.http } : {}) });
	const prepared = splitOpaqueArchive({ request, transport: input.transport,
		archive: original, ...(input.chunkBytes ? { chunkBytes: input.chunkBytes } : {}) });
	const temporary = await mkdtemp(path.join(input.temporaryParent, "opaque-archive-repartition-"));
	const parts: OpaqueArchivePart[] = [];
	try {
		for (const part of prepared.parts) {
			const root = path.join(temporary, part.artifactName);
			const file = path.join(root, part.fileName);
			await mkdir(root, { mode: 0o700 });
			try {
				await writeFile(file, part.bytes, { flag: "wx", mode: 0o600 });
				const identity = uploadedIdentity(await input.client.uploadArtifact(part.artifactName,
					[file], root, { retentionDays: 1 }));
				parts.push({ index: part.index, artifactName: part.artifactName,
					fileName: part.fileName, bytes: part.bytes.length, sha256: part.sha256,
					...identity });
			} finally { await rm(root, { recursive: true, force: true }); }
		}
		const manifest: OpaqueArchiveManifest = { version: 1,
			kind: "mul-pis-opaque-actions-archive-repartition", request,
			transport: { ...input.transport }, chunkBytes: input.chunkBytes ?? OPAQUE_ARCHIVE_CHUNK_BYTES,
			parts };
		if (!validateOpaqueArchiveManifest(manifest, request, input.transport))
			fail("repartition manifest cannot be published");
		const root = path.join(temporary, prepared.rootName);
		const file = path.join(root, OPAQUE_MANIFEST_FILE);
		await mkdir(root, { mode: 0o700 });
		try {
			await writeFile(file, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
			uploadedIdentity(await input.client.uploadArtifact(prepared.rootName, [file], root,
				{ retentionDays: 1 }));
		} finally { await rm(root, { recursive: true, force: true }); }
		return manifest;
	} finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function runOpaqueArchiveRepartitionFromFile(input: Readonly<{
	requestFile: string; githubToken: string; transport: TransportSource;
	temporaryParent: string; client: ArtifactClient; http?: typeof fetch;
}>): Promise<OpaqueArchiveManifest> {
	const bytes = await readFile(input.requestFile);
	if (bytes.length > 4096) fail("request file exceeds bound");
	return runOpaqueArchiveRepartition({ ...input,
		request: parseOpaqueArchiveRequest(bytes.toString("utf8")) });
}
