import assert from "node:assert/strict";
import test from "node:test";
import { reviewedLegacyV3SourceTree } from "../src/runner/ledger-continuation.ts";

const requestCommit = "f9d29bfd58449dba072c80f62a7db524f0a668c4";
const reviewedSource = "00d4309390bb06536abbe5e86f97213298e901a0";
const tree = "a".repeat(40);

function syntheticGitHub(change?: (commit: Record<string, unknown>, source: Record<string, unknown>) => void): typeof fetch {
	const submitted: Record<string, unknown> = { sha: requestCommit,
		parents: [{ sha: reviewedSource }], tree: { sha: tree } };
	const source: Record<string, unknown> = { sha: reviewedSource, tree: { sha: tree } };
	change?.(submitted, source);
	return async url => {
		const at = String(url);
		if (at.endsWith(`/git/commits/${requestCommit}`))
			return new Response(JSON.stringify(submitted), { status: 200 });
		if (at.endsWith(`/git/commits/${reviewedSource}`))
			return new Response(JSON.stringify(source), { status: 200 });
		throw new Error("unexpected synthetic GitHub request");
	};
}

test("exact one-time request has reviewed first parent and identical source tree", async () => {
	assert.equal(await reviewedLegacyV3SourceTree("synthetic-token", syntheticGitHub()), true);
});

test("one-time request rejects different first parent, tree, or API identity", async () => {
	assert.equal(await reviewedLegacyV3SourceTree("synthetic-token", syntheticGitHub(commit => {
		commit.parents = [{ sha: "b".repeat(40) }, { sha: reviewedSource }];
	})), false);
	assert.equal(await reviewedLegacyV3SourceTree("synthetic-token", syntheticGitHub(commit => {
		commit.tree = { sha: "c".repeat(40) };
	})), false);
	assert.equal(await reviewedLegacyV3SourceTree("synthetic-token", syntheticGitHub((_commit, source) => {
		source.sha = "d".repeat(40);
	})), false);
});
