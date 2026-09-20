import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	braveProvider,
	crossrefProvider,
	duckDuckGoProvider,
	githubIssuesProvider,
	hackerNewsProvider,
	openAlexProvider,
	redditProvider,
	stackExchangeProvider,
} from "../src/tools/search.ts";

describe("search pagination and scopes", () => {
	it("preserves both an HN story URL and its discussion entry", async () => {
		const mock = async <T>(): Promise<T> => ({
			page: 0,
			nbPages: 1,
			hits: [
				{ objectID: "42", title: "External story", url: "https://example.org/article" },
				{ objectID: "43", story_title: "Comment match", comment_text: "Relevant comment" },
			],
		}) as T;
		const out = await hackerNewsProvider(mock).search("topic", { limit: 2 });
		assert.equal(out.hits[0].url, "https://example.org/article");
		assert.equal(out.hits[0].discussionUrl, "https://news.ycombinator.com/item?id=42");
		assert.equal(out.hits[1].url, "https://news.ycombinator.com/item?id=43");
		assert.equal(out.hits[1].discussionUrl, undefined);
	});

	it("sends distinct OpenAlex page requests and preserves continuation", async () => {
		const urls: string[] = [];
		const mock = async <T>(url: string): Promise<T> => {
			urls.push(url);
			const page = new URL(url).searchParams.get("page");
			return { results: [{ id: `https://openalex.org/W${page}`, title: `page ${page}` }], meta: { next_cursor: `cursor-${page}` } } as T;
		};
		const provider = openAlexProvider(undefined, mock);
		const first = await provider.search("mechanism", { limit: 10, page: 1 });
		const second = await provider.search("mechanism", { limit: 10, page: 2 });
		assert.notDeepEqual(first.hits, second.hits);
		assert.equal(second.page, 2);
		assert.equal(second.nextCursor, "cursor-2");
		assert.equal(new URL(urls[1]).searchParams.get("page"), "2");
	});

	it("applies Stack Exchange site and reports unsupported cursor", async () => {
		let requested = "";
		const mock = async <T>(url: string): Promise<T> => {
			requested = url;
			return { items: [], has_more: true, quota_remaining: 100 } as T;
		};
		const out = await stackExchangeProvider("stackoverflow", mock).search("quantum", { limit: 5, page: 2, site: "physics", cursor: "opaque" });
		const params = new URL(requested).searchParams;
		assert.equal(params.get("site"), "physics");
		assert.equal(params.get("page"), "2");
		assert.equal(out.query, "site:physics quantum");
		assert.equal(out.nextPage, 3);
		assert.ok(out.warnings.some((w) => w.includes("cursor")));
	});

	it("uses Reddit opaque continuation without leaking it into outcome query", async () => {
		let requested = "";
		const mock = async <T>(url: string): Promise<T> => {
			requested = url;
			return { data: { after: "t3_next", children: [] } } as T;
		};
		const out = await redditProvider(mock).search("replication", { limit: 4, cursor: "t3_prior", site: "science" });
		const params = new URL(requested).searchParams;
		assert.equal(params.get("after"), "t3_prior");
		assert.equal(params.get("q"), "replication subreddit:science");
		assert.equal(out.nextCursor, "t3_next");
		assert.ok(!out.query.includes("t3_prior"));
	});

	it("scopes Brave by domain and records effective query and page", async () => {
		let requested = "";
		const mock = async <T>(url: string): Promise<T> => {
			requested = url;
			return { web: { results: [{ title: "Result", url: "https://example.org/r" }] } } as T;
		};
		const out = await braveProvider("secret", mock).search("causal inference", { limit: 10, page: 3, site: "example.org" });
		const params = new URL(requested).searchParams;
		assert.equal(params.get("q"), "causal inference site:example.org");
		assert.equal(params.get("offset"), "2");
		assert.equal(out.query, "causal inference site:example.org");
		assert.equal(out.page, 3);
		assert.ok(!requested.includes("secret"));
	});

	it("does not fake DuckDuckGo continuation", async () => {
		const mock = async (url: string) => ({ status: 200, contentType: "text/html", text: "", finalUrl: url });
		const out = await duckDuckGoProvider(mock).search("topic", { limit: 10, page: 2, cursor: "token", site: "example.org" });
		assert.equal(out.page, undefined);
		assert.equal(out.nextPage, undefined);
		assert.equal(out.nextCursor, undefined);
		assert.ok(out.warnings.some((w) => w.includes("浏览器继续翻页")));
		assert.equal(out.query, "topic site:example.org");
	});

	it("keeps Crossref over-limit paging honest and does not request", async () => {
		let calls = 0;
		const mock = async <T>(): Promise<T> => {
			calls += 1;
			return {} as T;
		};
		const out = await crossrefProvider(undefined, mock).search("topic", { limit: 50, page: 202 });
		assert.equal(calls, 0);
		assert.equal(out.hits.length, 0);
		assert.ok(out.warnings.some((w) => w.includes("10000")));
	});

	it("searches GitHub issues with explicit origin and warns on unsupported site", async () => {
		let requested = "";
		const mock = async <T>(url: string): Promise<T> => {
			requested = url;
			return { total_count: 1, items: [{ title: "Discussion", html_url: "https://github.com/o/r/issues/1" }] } as T;
		};
		const out = await githubIssuesProvider(mock).search("scheduler", { limit: 5, site: "example.org" });
		assert.equal(out.endpoint, "https://api.github.com/search/issues");
		assert.equal(new URL(requested).searchParams.get("q"), "scheduler is:issue");
		assert.equal(out.hits[0].provider, "github-issues");
		assert.ok(out.warnings.some((w) => w.includes("site")));
	});
});
