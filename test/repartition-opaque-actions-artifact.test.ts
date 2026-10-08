import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadVerifiedOpaqueArchive, OPAQUE_ARCHIVE_CHUNK_BYTES,
	OPAQUE_MANIFEST_FILE, parseOpaqueArchiveRequest, restoreOpaqueArchive,
	runOpaqueArchiveRepartition, validateOpaqueArchiveManifest,
	type OpaqueArchiveRequest } from "../scripts/repartition-opaque-actions-artifact.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const original = Buffer.from("Opaque encrypted ZIP bytes stay uninterpreted: \x00\xff\x17".repeat(3));
const request: OpaqueArchiveRequest = {
	version: 1, kind: "mul-pis-opaque-archive-repartition-request",
	repository: "SakuyaInazaki/Mul-Pis", sourceRunId: "70047", sourceArtifactId: "90077",
	sourceCommit: "a".repeat(40), sourceArtifactName: "confidential-campaign-envelope",
	archiveBytes: original.length, archiveSha256: hash(original),
};
const transport = { runId: "80048", runAttempt: 1, commit: "b".repeat(40) };
function fakeHttp(changes: Readonly<{ runHead?: string; headBranch?: string; workflowPath?: string;
	runStatus?: string; runConclusion?: string; runEvent?: string; runAttempt?: number; artifactId?: number;
	artifactDigest?: string; expired?: boolean; redirect?: string; archive?: Buffer }> = {}) {
	const calls: Array<{ url: string; authorization: string | null;
		redirect: RequestInit["redirect"] }> = [];
	const http: typeof fetch = async (url, init) => {
		const address = String(url);
		const headers = new Headers(init?.headers);
		calls.push({ url: address, authorization: headers.get("authorization"),
			redirect: init?.redirect });
		if (address.endsWith("/actions/runs/70047")) return new Response(JSON.stringify({
			id: 70047, head_sha: changes.runHead ?? request.sourceCommit,
			head_branch: changes.headBranch ?? "run-requests/workflow-learning-reliability",
			path: changes.workflowPath ?? ".github/workflows/manual-private-campaign.yml",
			status: changes.runStatus ?? "completed", conclusion: changes.runConclusion ?? "cancelled",
			event: changes.runEvent ?? "push", run_attempt: changes.runAttempt ?? 1 }), { status: 200 });
		if (address.endsWith("/actions/artifacts/90077")) return new Response(JSON.stringify({
			id: changes.artifactId ?? 90077, name: "confidential-campaign-envelope",
			expired: changes.expired ?? false,
			digest: changes.artifactDigest ?? `sha256:${request.archiveSha256}`,
			workflow_run: { id: 70047, head_sha: request.sourceCommit } }), { status: 200 });
		if (address.endsWith("/actions/artifacts/90077/zip")) return new Response(null, {
			status: 302, headers: { location: changes.redirect ??
				"https://safe.blob.core.windows.net/opaque/source.zip" } });
		if (address === "https://safe.blob.core.windows.net/opaque/source.zip") {
			const archive = changes.archive ?? original;
			return new Response(archive, { status: 200,
				headers: { "content-length": String(archive.length) } });
		}
		throw Error(`unexpected synthetic route ${address}`);
	};
	return { http, calls };
}

test("opaque ZIP is identity checked, split into immutable small parts, and indexed last", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-opaque-repartition-"));
	const { http, calls } = fakeHttp();
	const uploads: Array<{ name: string; member: string; bytes: Buffer;
		id: number; digest: string; retention: number }> = [];
	try {
		const manifest = await runOpaqueArchiveRepartition({ request, githubToken: "synthetic-read-token",
			transport, temporaryParent: directory, http, chunkBytes: 29,
			client: { uploadArtifact: async (name, files, root, options) => {
				assert.equal(path.dirname(files[0]!), root);
				assert.deepEqual(await readdir(root), [path.basename(files[0]!)]);
				const bytes = await readFile(files[0]!);
				const id = 3000 + uploads.length;
				const digest = hash(`synthetic-archive-${id}`);
				uploads.push({ name, member: path.basename(files[0]!), bytes, id, digest,
					retention: options.retentionDays });
				return { id, digest: uploads.length % 2 ? digest : `sha256:${digest}` };
			} } });
		assert.equal(manifest.parts.length, Math.ceil(original.length / 29));
		assert.equal(uploads.length, manifest.parts.length + 1);
		assert.equal(uploads.at(-1)!.member, OPAQUE_MANIFEST_FILE);
		assert.equal(uploads.at(-1)!.name,
			"confidential-opaque-archive-70047-90077-80048-1");
		assert.ok(uploads.every(row => row.retention === 1));
		assert.ok(uploads.slice(0, -1).every(row => row.bytes.length <= 29));
		assert.ok(validateOpaqueArchiveManifest(manifest, request, transport));
		assert.deepEqual(JSON.parse(uploads.at(-1)!.bytes.toString("utf8")), manifest);
		const restored = restoreOpaqueArchive({ manifest, parts: manifest.parts.map(part => {
			const uploaded = uploads.find(row => row.name === part.artifactName)!;
			return { artifactId: String(uploaded.id), archiveSha256: uploaded.digest,
				bytes: uploaded.bytes };
		}) });
		assert.deepEqual(restored, original);
		assert.equal(calls.length, 4);
		assert.ok(calls.slice(0, 3).every(row => row.authorization === "Bearer synthetic-read-token"));
		assert.equal(calls[3]!.authorization, null, "token is never forwarded to blob redirect");
		assert.equal(calls[2]!.redirect, "manual");
		assert.deepEqual(await readdir(directory), [], "opaque source and part files are removed after upload");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("source identity, original SHA, redirect target, and exact byte count are required", async () => {
	for (const changed of [
		{ runHead: "f".repeat(40) }, { headBranch: "other" }, { workflowPath: "other.yml" },
		{ runStatus: "in_progress" }, { runConclusion: "success" },
		{ runEvent: "workflow_dispatch" }, { runAttempt: 2 },
		{ artifactId: 9 }, { artifactDigest: "sha256:" + "0".repeat(64) },
		{ expired: true }, { redirect: "https://attacker.example/steal" },
		{ archive: original.subarray(0, original.length - 1) },
		{ archive: Buffer.concat([original.subarray(0, original.length - 1), Buffer.from("x")]) },
	]) {
		const { http } = fakeHttp(changed);
		await assert.rejects(downloadVerifiedOpaqueArchive({ request,
			githubToken: "synthetic-read-token", http }));
	}
	assert.throws(() => parseOpaqueArchiveRequest(JSON.stringify({ ...request,
		sourceCommit: "PENDING" })));
	assert.throws(() => parseOpaqueArchiveRequest(JSON.stringify({ ...request,
		archiveBytes: OPAQUE_ARCHIVE_CHUNK_BYTES * 9 })));
});

test("an ambiguous part upload leaves no final index and no retained opaque copy", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-opaque-repartition-failed-"));
	const names: string[] = [];
	try {
		await assert.rejects(runOpaqueArchiveRepartition({ request, githubToken: "synthetic-read-token",
			transport, temporaryParent: directory, http: fakeHttp().http, chunkBytes: 29,
			client: { uploadArtifact: async name => {
				names.push(name);
				if (names.length === 2) throw Error("ambiguous upload");
				return { id: 3000 + names.length, digest: hash(`zip-${names.length}`) };
			} } }));
		assert.equal(names.length, 2);
		assert.ok(names.every(name => name.includes("-part-")));
		assert.deepEqual(await readdir(directory), []);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing final index upload receipt cannot be reported as success", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-opaque-repartition-root-gap-"));
	const names: string[] = [];
	try {
		await assert.rejects(runOpaqueArchiveRepartition({ request, githubToken: "synthetic-read-token",
			transport, temporaryParent: directory, http: fakeHttp().http, chunkBytes: 29,
			client: { uploadArtifact: async name => {
				names.push(name);
				if (!name.includes("-part-")) return { id: 4000 };
				return { id: 3000 + names.length, digest: hash(`zip-${names.length}`) };
			} } }));
		assert.ok(names.length > 1);
		assert.equal(names.at(-1), "confidential-opaque-archive-70047-90077-80048-1");
		assert.equal(names.filter(name => !name.includes("-part-")).length, 1,
			"an ambiguous final result is not retried");
		assert.deepEqual(await readdir(directory), []);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("restoration detects an altered part or archive identity", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-opaque-repartition-verify-"));
	const uploaded: Array<{ name: string; bytes: Buffer; digest: string; id: string }> = [];
	try {
		const manifest = await runOpaqueArchiveRepartition({ request, githubToken: "synthetic-read-token",
			transport, temporaryParent: directory, http: fakeHttp().http, chunkBytes: 29,
			client: { uploadArtifact: async (name, files) => {
				const id = String(4000 + uploaded.length);
				const digest = hash(`artifact-zip-${id}`);
				uploaded.push({ name, bytes: await readFile(files[0]!), digest, id });
				return { id: Number(id), digest };
			} } });
		const parts = manifest.parts.map(row => {
			const item = uploaded.find(entry => entry.name === row.artifactName)!;
			return { artifactId: item.id, archiveSha256: item.digest, bytes: item.bytes };
		});
		assert.deepEqual(restoreOpaqueArchive({ manifest, parts }), original);
		const reordered = { ...manifest,
			request: Object.fromEntries(Object.entries(manifest.request).reverse()),
			transport: Object.fromEntries(Object.entries(manifest.transport).reverse()) } as
			unknown as typeof manifest;
		assert.ok(validateOpaqueArchiveManifest(reordered, request, transport));
		assert.deepEqual(restoreOpaqueArchive({ manifest: reordered, parts }), original);
		await assert.rejects(async () => restoreOpaqueArchive({ manifest,
			parts: [{ ...parts[0]!, archiveSha256: "0".repeat(64) }, ...parts.slice(1)] }));
		await assert.rejects(async () => restoreOpaqueArchive({ manifest,
			parts: [{ ...parts[0]!, bytes: Buffer.alloc(parts[0]!.bytes.length) }, ...parts.slice(1)] }));
	} finally { await rm(directory, { recursive: true, force: true }); }
});
