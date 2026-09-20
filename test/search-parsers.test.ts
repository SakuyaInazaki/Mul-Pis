/** Offline tests for the search response parsers and provider selection. No network. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArxivAtom, parseDuckDuckGoHtml, providersFor } from "../src/tools/search.ts";
import { detectIdentifier } from "../src/tools/openaccess.ts";

describe("search parsers", () => {
	it("parses arXiv Atom entries with pdf links", () => {
		const xml = `<feed><entry><id>http://arxiv.org/abs/2607.15524v1</id><title>Recursive\n Harness</title><summary> Sum </summary><published>2026-07-01T00:00:00Z</published><author><name>A B</name></author><link title="pdf" href="https://arxiv.org/pdf/2607.15524v1" rel="related"/></entry></feed>`;
		const hits = parseArxivAtom(xml);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].title, "Recursive Harness");
		assert.equal(hits[0].oaUrl, "https://arxiv.org/pdf/2607.15524v1");
		assert.deepEqual(hits[0].authors, ["A B"]);
	});

	it("parses DuckDuckGo HTML results and unwraps redirect links", () => {
		const html = `<div class="result results_links"><div class="links_main"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpaper&amp;rut=1">Example <b>Paper</b></a><a class="result__snippet" href="x">A short &amp; useful snippet</a></div></div><div class="result"><a class="result__a" href="https://direct.example/">Direct</a></div>`;
		const hits = parseDuckDuckGoHtml(html);
		assert.equal(hits.length, 2);
		assert.equal(hits[0].url, "https://example.org/paper");
		assert.equal(hits[0].title, "Example Paper");
		assert.equal(hits[0].snippet, "A short & useful snippet");
		assert.equal(hits[1].url, "https://direct.example/");
	});

	it("selects providers from config without any local service", () => {
		const names = providersFor({}).map((p) => p.name);
		assert.deepEqual(names, ["openalex", "arxiv", "crossref", "hackernews", "stackexchange", "github", "github-issues", "duckduckgo"]);
		assert.ok(providersFor({ braveApiKey: "k" }).some((p) => p.name === "brave"));
		assert.deepEqual(providersFor({ searchProviders: ["arxiv", "github", "reddit"] }).map((p) => p.name), ["arxiv", "github", "reddit"], "reddit is opt-in");
	});

	it("detects DOI and arXiv identifiers", () => {
		assert.deepEqual(detectIdentifier("https://doi.org/10.1038/nature14539"), { kind: "doi", id: "10.1038/nature14539" });
		assert.deepEqual(detectIdentifier("arXiv:2609.20519"), { kind: "arxiv", id: "2609.20519" });
		assert.equal(detectIdentifier("hello world").kind, "unknown");
	});
});
