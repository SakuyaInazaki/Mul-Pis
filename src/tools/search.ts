/**
 * Search providers for M05. No local service, no Docker, no key required for the defaults.
 * - OpenAlex, arXiv: scholarly works (free APIs), with DOI / open-access locations.
 * - Hacker News (Algolia), Stack Exchange, Reddit, GitHub: community sources through their
 *   official public endpoints (rate-limited, keyless).
 * - DuckDuckGo HTML: keyless general-web search over the public HTML endpoint; best effort,
 *   may throttle, marked as such in warnings.
 * - Brave Search API: general-web search when the user provides a key.
 * Hits are discovery data only; nothing here is evidence until fetched and read.
 */
import { fetchJson, fetchText } from "./http.ts";
import type { ToolsConfig } from "../types.ts";

export interface SearchHit {
	provider: string;
	title: string;
	url: string;
	/** Separate community discussion entry when the primary URL is an external resource. */
	discussionUrl?: string;
	snippet?: string;
	date?: string;
	doi?: string;
	/** Open-access full-text URL when the provider reports one (OpenAlex best_oa_location, arXiv pdf). */
	oaUrl?: string;
	authors?: string[];
	venue?: string;
}

export interface SearchOutcome {
	provider: string;
	query: string;
	limit: number;
	hits: SearchHit[];
	warnings: string[];
	/** Endpoint used, without secrets, for the search log. */
	endpoint: string;
	/** One-based page actually requested when the endpoint uses numbered pages. */
	page?: number;
	/** Next one-based page only when the endpoint reports or implies that one exists. */
	nextPage?: number;
	/** Opaque continuation token returned by the provider. Never contains credentials. */
	nextCursor?: string;
}

export interface SearchOptions {
	limit: number;
	/** One-based page. Providers that do not support numbered pages warn instead of ignoring it. */
	page?: number;
	/** Opaque provider continuation token. Providers that do not support it warn instead of ignoring it. */
	cursor?: string;
	/** Stack Exchange site or general-web domain scope. Other providers warn instead of ignoring it. */
	site?: string;
}

export interface SearchProvider {
	name: string;
	description: string;
	search(query: string, options: SearchOptions): Promise<SearchOutcome>;
}

type JsonFetcher = typeof fetchJson;
type TextFetcher = typeof fetchText;

function pageNumber(page: number | undefined): number {
	return Number.isFinite(page) ? Math.max(1, Math.floor(page!)) : 1;
}

function unsupported(options: SearchOptions, supported: Array<"page" | "cursor" | "site">): string[] {
	const warnings: string[] = [];
	if (options.page !== undefined && !supported.includes("page")) warnings.push("此提供方不支持 page；参数未应用");
	if (options.cursor !== undefined && !supported.includes("cursor")) warnings.push("此提供方不支持 cursor；参数未应用");
	if (options.site !== undefined && !supported.includes("site")) warnings.push("此提供方不支持 site；参数未应用");
	return warnings;
}

function scopedQuery(query: string, site?: string): string {
	return site ? `${query} site:${site}` : query;
}

const clean = (s: string | undefined | null): string => (s ?? "").replace(/\s+/g, " ").trim();

function decodeEntities(s: string): string {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
}

/* ------------------------------------------------------------------ scholarly */

interface OpenAlexWork {
	id?: string;
	doi?: string | null;
	title?: string | null;
	display_name?: string | null;
	publication_year?: number | null;
	publication_date?: string | null;
	authorships?: Array<{ author?: { display_name?: string } }>;
	primary_location?: { landing_page_url?: string | null; source?: { display_name?: string | null } | null } | null;
	open_access?: { is_oa?: boolean; oa_url?: string | null } | null;
	best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null; license?: string | null } | null;
}

export function openAlexHit(w: OpenAlexWork): SearchHit {
	const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//i, "") : undefined;
	return {
		provider: "openalex",
		title: w.title ?? w.display_name ?? "",
		url: w.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : (w.id ?? "")),
		date: w.publication_date ?? (w.publication_year ? String(w.publication_year) : undefined),
		doi,
		oaUrl: w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? undefined,
		authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean),
		venue: w.primary_location?.source?.display_name ?? undefined,
	};
}

export function openAlexProvider(mailto?: string, getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "openalex",
		description: "OpenAlex 学术文献检索：DOI、发表信息与开放获取地址",
		async search(query, options) {
			const { limit, cursor } = options;
			const page = pageNumber(options.page);
			const params = new URLSearchParams({ search: query, "per-page": String(Math.min(limit, 50)), select: "id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,open_access,best_oa_location" });
			if (cursor) params.set("cursor", cursor);
			else if (options.page !== undefined) params.set("page", String(page));
			if (mailto) params.set("mailto", mailto);
			const data = await getJson<{ results?: OpenAlexWork[]; meta?: { count?: number; next_cursor?: string | null } }>(`https://api.openalex.org/works?${params.toString()}`);
			const warnings = unsupported(options, ["page", "cursor"]);
			if (cursor && options.page !== undefined) warnings.push("同时提供 page 与 cursor 时优先使用 cursor；page 未应用");
			const count = Math.min(limit, 50);
			return { provider: "openalex", query, limit, hits: (data.results ?? []).map(openAlexHit), warnings, endpoint: "https://api.openalex.org/works", ...(cursor ? {} : { page, nextPage: page * count < (data.meta?.count ?? 0) ? page + 1 : undefined }), nextCursor: data.meta?.next_cursor ?? undefined };
		},
	};
}

export function parseArxivAtom(xml: string): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const entry of xml.split(/<entry>/).slice(1)) {
		const pick = (tag: string): string => clean(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1]);
		const id = pick("id");
		const pdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(entry)?.[1];
		const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
		const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, "");
		hits.push({ provider: "arxiv", title: pick("title"), url: id, snippet: pick("summary"), date: pick("published"), oaUrl: pdf ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined), authors, venue: "arXiv" });
	}
	return hits;
}

export function arxivProvider(getText: TextFetcher = fetchText): SearchProvider {
	return {
		name: "arxiv",
		description: "arXiv 预印本检索：标题、摘要、发布日期与 PDF 地址",
		async search(query, options) {
			const { limit } = options;
			const page = pageNumber(options.page);
			const count = Math.min(limit, 50);
			const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query}`)}&start=${(page - 1) * count}&max_results=${count}`;
			const { text, status } = await getText(url);
			const baseWarnings = unsupported(options, ["page"]);
			if (status !== 200) return { provider: "arxiv", query, limit, hits: [], warnings: [...baseWarnings, `arXiv 返回 HTTP ${status}`], endpoint: "https://export.arxiv.org/api/query", page };
			const hits = parseArxivAtom(text);
			const total = Number(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/.exec(text)?.[1] ?? NaN);
			return { provider: "arxiv", query, limit, hits, warnings: baseWarnings, endpoint: "https://export.arxiv.org/api/query", page, nextPage: Number.isFinite(total) && page * count < total ? page + 1 : undefined };
		},
	};
}

/* ------------------------------------------------------------------ communities (official keyless APIs) */

export function hackerNewsProvider(getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "hackernews",
		description: "Hacker News 讨论检索（Algolia 官方接口）",
		async search(query, options) {
			const { limit } = options;
			const page = pageNumber(options.page);
			const data = await getJson<{ page?: number; nbPages?: number; hits?: Array<{ title?: string; story_title?: string; url?: string; objectID?: string; created_at?: string; points?: number; num_comments?: number; comment_text?: string; story_text?: string }> }>(
				`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(limit, 50)}&page=${page - 1}`,
			);
			const hits: SearchHit[] = (data.hits ?? []).map((h) => {
				const discussionUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
				const primaryUrl = h.url || discussionUrl;
				return {
					provider: "hackernews",
					title: clean(h.title ?? h.story_title),
					url: primaryUrl,
					discussionUrl: primaryUrl === discussionUrl ? undefined : discussionUrl,
					snippet: clean(h.story_text ?? h.comment_text ?? "").slice(0, 400),
					date: h.created_at,
					venue: `HN ${h.points ?? 0} 分 / ${h.num_comments ?? 0} 评论`,
				};
			});
			return { provider: "hackernews", query, limit, hits, warnings: unsupported(options, ["page"]), endpoint: "https://hn.algolia.com/api/v1/search", page, nextPage: (data.page ?? page - 1) + 1 < (data.nbPages ?? 0) ? page + 1 : undefined };
		},
	};
}

export function stackExchangeProvider(site: string = "stackoverflow", getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "stackexchange",
		description: "Stack Exchange 问答检索（官方接口，默认 stackoverflow，可用 site: 前缀指定站点，如 site:physics）",
		async search(query, options) {
			const { limit } = options;
			const page = pageNumber(options.page);
			const m = /^site:(\S+)\s+/.exec(query);
			const target = options.site ?? (m ? m[1] : site);
			const q = m ? query.slice(m[0].length) : query;
			const data = await getJson<{ items?: Array<{ title?: string; link?: string; creation_date?: number; score?: number; answer_count?: number; is_answered?: boolean; tags?: string[] }>; quota_remaining?: number; has_more?: boolean; backoff?: number }>(
				`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=${encodeURIComponent(target)}&pagesize=${Math.min(limit, 50)}&page=${page}`,
			);
			const hits: SearchHit[] = (data.items ?? []).map((i) => ({
				provider: "stackexchange",
				title: decodeEntities(clean(i.title)),
				url: i.link ?? "",
				date: i.creation_date ? new Date(i.creation_date * 1000).toISOString().slice(0, 10) : undefined,
				snippet: `${i.is_answered ? "已有采纳/回答" : "未解决"}；${i.answer_count ?? 0} 个回答；得分 ${i.score ?? 0}；标签 ${(i.tags ?? []).join(", ")}`,
				venue: target,
			}));
			const warnings = typeof data.quota_remaining === "number" && data.quota_remaining < 20 ? [`Stack Exchange 无密钥配额剩余 ${data.quota_remaining}`] : [];
			if (data.backoff) warnings.push(`Stack Exchange 要求等待 ${data.backoff} 秒后再请求`);
			warnings.push(...unsupported(options, ["page", "site"]));
			return { provider: "stackexchange", query: `site:${target} ${q}`, limit, hits, warnings, endpoint: "https://api.stackexchange.com/2.3/search/advanced", page, nextPage: data.has_more ? page + 1 : undefined };
		},
	};
}

export function redditProvider(getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "reddit",
		description: "Reddit 帖子检索（公开 JSON 接口，无密钥时限流较严）",
		async search(query, options) {
			const { limit } = options;
			const effectiveQuery = options.site ? `${query} subreddit:${options.site.replace(/^r\//, "")}` : query;
			const params = new URLSearchParams({ q: effectiveQuery, limit: String(Math.min(limit, 50)), sort: "relevance" });
			if (options.cursor) params.set("after", options.cursor);
			const data = await getJson<{ data?: { after?: string | null; children?: Array<{ data?: { title?: string; permalink?: string; subreddit?: string; created_utc?: number; score?: number; num_comments?: number; selftext?: string; url?: string } }> } }>(
				`https://www.reddit.com/search.json?${params.toString()}`,
				{ headers: { accept: "application/json" } },
			);
			const hits: SearchHit[] = (data.data?.children ?? []).map(({ data: d }) => ({
				provider: "reddit",
				title: clean(d?.title),
				url: d?.permalink ? `https://www.reddit.com${d.permalink}` : (d?.url ?? ""),
				date: d?.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : undefined,
				snippet: clean(d?.selftext).slice(0, 300),
				venue: d?.subreddit ? `r/${d.subreddit}（${d.score ?? 0} 分 / ${d.num_comments ?? 0} 评论）` : undefined,
			}));
			const warnings = unsupported(options, ["cursor", "site"]);
			if (!hits.length) warnings.push("Reddit 未返回结果；无密钥访问可能被限流或要求登录");
			return { provider: "reddit", query: effectiveQuery, limit, hits, warnings, endpoint: "https://www.reddit.com/search.json", nextCursor: data.data?.after ?? undefined };
		},
	};
}

export function githubProvider(getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "github",
		description: "GitHub 仓库检索（官方接口，无密钥每分钟约 10 次）",
		async search(query, options) {
			const { limit } = options;
			const page = pageNumber(options.page);
			const effectiveQuery = query;
			const data = await getJson<{ total_count?: number; incomplete_results?: boolean; items?: Array<{ full_name?: string; html_url?: string; description?: string | null; stargazers_count?: number; pushed_at?: string; language?: string | null }> }>(
				`https://api.github.com/search/repositories?q=${encodeURIComponent(effectiveQuery)}&per_page=${Math.min(limit, 50)}&page=${page}`,
				{ headers: { accept: "application/vnd.github+json" } },
			);
			const hits: SearchHit[] = (data.items ?? []).map((r) => ({
				provider: "github",
				title: clean(r.full_name),
				url: r.html_url ?? "",
				snippet: clean(r.description ?? "").slice(0, 300),
				date: r.pushed_at?.slice(0, 10),
				venue: `GitHub ${r.stargazers_count ?? 0} stars${r.language ? ` / ${r.language}` : ""}`,
			}));
			const warnings = unsupported(options, ["page"]);
			if ((data.total_count ?? 0) > 1000) warnings.push("GitHub Search API 仅允许访问前 1000 条匹配结果");
			if (data.incomplete_results) warnings.push("GitHub 报告结果不完整，可能因搜索超时或限制而缺失");
			const accessible = Math.min(data.total_count ?? 0, 1000);
			return { provider: "github", query: effectiveQuery, limit, hits, warnings, endpoint: "https://api.github.com/search/repositories", page, nextPage: page * Math.min(limit, 50) < accessible ? page + 1 : undefined };
		},
	};
}

export function githubIssuesProvider(getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "github-issues",
		description: "GitHub issues 检索（官方搜索接口；不包含 Discussions）",
		async search(query, options) {
			const { limit } = options;
			const page = pageNumber(options.page);
			const effectiveQuery = `${query} is:issue`;
			const data = await getJson<{ total_count?: number; incomplete_results?: boolean; items?: Array<{ title?: string; html_url?: string; body?: string | null; created_at?: string; repository_url?: string; comments?: number; state?: string }> }>(
				`https://api.github.com/search/issues?q=${encodeURIComponent(effectiveQuery)}&per_page=${Math.min(limit, 50)}&page=${page}`,
				{ headers: { accept: "application/vnd.github+json" } },
			);
			const hits = (data.items ?? []).map((i): SearchHit => ({ provider: "github-issues", title: clean(i.title), url: i.html_url ?? "", snippet: clean(i.body).slice(0, 300), date: i.created_at?.slice(0, 10), venue: `GitHub issue · ${i.state ?? "unknown"} · ${i.comments ?? 0} comments` }));
			const warnings = unsupported(options, ["page"]);
			if ((data.total_count ?? 0) > 1000) warnings.push("GitHub Search API 仅允许访问前 1000 条匹配结果");
			if (data.incomplete_results) warnings.push("GitHub 报告结果不完整，可能因搜索超时或限制而缺失");
			const accessible = Math.min(data.total_count ?? 0, 1000);
			return { provider: "github-issues", query: effectiveQuery, limit, hits, warnings, endpoint: "https://api.github.com/search/issues", page, nextPage: page * Math.min(limit, 50) < accessible ? page + 1 : undefined };
		},
	};
}

interface CrossrefItem {
	DOI?: string;
	title?: string[];
	URL?: string;
	abstract?: string;
	issued?: { "date-parts"?: number[][] };
	author?: Array<{ given?: string; family?: string }>;
	"container-title"?: string[];
}

export function crossrefProvider(mailto?: string, getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "crossref",
		description: "Crossref 学术元数据检索（官方 REST API，DOI 与出版信息）",
		async search(query, options) {
			const { limit, cursor } = options;
			const page = pageNumber(options.page);
			const rows = Math.min(limit, 50);
			const offset = (page - 1) * rows;
			const warnings = unsupported(options, ["page", "cursor"]);
			if (cursor && options.page !== undefined) warnings.push("同时提供 page 与 cursor 时优先使用 cursor；page 未应用");
			if (!cursor && offset > 10_000) {
				warnings.push("Crossref REST API 的 offset 上限为 10000；本页未请求，请缩小范围或使用其他检索方式");
				return { provider: "crossref", query, limit, hits: [], warnings, endpoint: "https://api.crossref.org/works", page };
			}
			const params = new URLSearchParams({ query, rows: String(rows), select: "DOI,title,URL,abstract,issued,author,container-title" });
			if (cursor) params.set("cursor", cursor);
			else params.set("offset", String(offset));
			if (mailto) params.set("mailto", mailto);
			const data = await getJson<{ message?: { items?: CrossrefItem[]; "total-results"?: number; "next-cursor"?: string } }>(`https://api.crossref.org/works?${params.toString()}`);
			const hits = (data.message?.items ?? []).map((i): SearchHit => ({
				provider: "crossref",
				title: clean(i.title?.[0]),
				url: i.URL ?? (i.DOI ? `https://doi.org/${i.DOI}` : ""),
				doi: i.DOI,
				snippet: clean(i.abstract?.replace(/<[^>]+>/g, "")).slice(0, 300),
				date: i.issued?.["date-parts"]?.[0]?.join("-"),
				authors: (i.author ?? []).map((a) => clean(`${a.given ?? ""} ${a.family ?? ""}`)).filter(Boolean),
				venue: i["container-title"]?.[0],
			}));
			const total = data.message?.["total-results"] ?? 0;
			return { provider: "crossref", query, limit, hits, warnings, endpoint: "https://api.crossref.org/works", ...(cursor ? {} : { page, nextPage: offset + hits.length < total && offset + rows <= 10_000 ? page + 1 : undefined }), nextCursor: data.message?.["next-cursor"] };
		},
	};
}

/* ------------------------------------------------------------------ general web */

/** Parse DuckDuckGo's HTML results page (public endpoint). Best effort; layout may change. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
	const hits: SearchHit[] = [];
	const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/).slice(1);
	for (const block of blocks) {
		const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!link) continue;
		let href = decodeEntities(link[1]);
		const redirect = /[?&]uddg=([^&]+)/.exec(href);
		if (redirect) href = decodeURIComponent(redirect[1]);
		if (href.startsWith("//")) href = `https:${href}`;
		const snippet = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? "";
		hits.push({ provider: "duckduckgo", title: decodeEntities(clean(link[2].replace(/<[^>]+>/g, ""))), url: href, snippet: decodeEntities(clean(snippet.replace(/<[^>]+>/g, ""))).slice(0, 300) });
	}
	return hits;
}

export function duckDuckGoProvider(getText: TextFetcher = fetchText): SearchProvider {
	return {
		name: "duckduckgo",
		description: "DuckDuckGo 通用网页检索（无需密钥的公开 HTML 接口；尽力而为，可能限流）",
		async search(query, options) {
			const { limit } = options;
			const effectiveQuery = scopedQuery(query, options.site);
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(effectiveQuery)}`;
			const { text, status } = await getText(url, { headers: { accept: "text/html" } });
			const warnings: string[] = ["非官方 API：结果来自公开 HTML 页面，可能不稳定或被限流"];
			warnings.push(...unsupported(options, ["site"]));
			if (options.page !== undefined || options.cursor !== undefined) warnings.push("DuckDuckGo HTML continuation 未可靠实现；请使用浏览器继续翻页");
			if (status !== 200) return { provider: "duckduckgo", query: effectiveQuery, limit, hits: [], warnings: [...warnings, `HTTP ${status}`], endpoint: "https://html.duckduckgo.com/html/" };
			const hits = parseDuckDuckGoHtml(text).slice(0, limit);
			if (!hits.length && /anomaly|captcha|bot/i.test(text)) warnings.push("DuckDuckGo 返回了人机验证页，本次无结果");
			return { provider: "duckduckgo", query: effectiveQuery, limit, hits, warnings, endpoint: "https://html.duckduckgo.com/html/" };
		},
	};
}

export function braveProvider(apiKey: string, getJson: JsonFetcher = fetchJson): SearchProvider {
	return {
		name: "brave",
		description: "Brave Search API 通用网页检索（需用户提供密钥）",
		async search(query, options) {
			const { limit } = options;
			const page = pageNumber(options.page);
			const effectiveQuery = scopedQuery(query, options.site);
			const count = Math.min(limit, 20);
			if (page > 10) return { provider: "brave", query: effectiveQuery, limit, hits: [], warnings: [...unsupported(options, ["page", "site"]), "Brave Web Search 仅支持前 10 个 offset 页；本页未请求"], endpoint: "https://api.search.brave.com/res/v1/web/search", page };
			const data = await getJson<{ web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> } }>(
				`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(effectiveQuery)}&count=${count}&offset=${page - 1}`,
				{ headers: { "X-Subscription-Token": apiKey, accept: "application/json" } },
			);
			const hits: SearchHit[] = (data.web?.results ?? []).map((r) => ({ provider: "brave", title: clean(r.title), url: r.url ?? "", snippet: decodeEntities(clean(r.description).replace(/<[^>]+>/g, "")).slice(0, 300), date: r.page_age?.slice(0, 10) ?? r.age }));
			const warnings = unsupported(options, ["page", "site"]);
			return { provider: "brave", query: effectiveQuery, limit, hits, warnings, endpoint: "https://api.search.brave.com/res/v1/web/search", page };
		},
	};
}

/**
 * Providers available under a config: scholarly + community + keyless general web, plus Brave when a
 * key is configured. Reddit is opt-in only (its public JSON search answers 403 to unauthenticated
 * clients as of 2026-09-20). `tools.searchProviders` restricts the set (by name) when present.
 */
export function providersFor(tools: ToolsConfig): SearchProvider[] {
	const defaults: SearchProvider[] = [openAlexProvider(tools.openAlexMailto), arxivProvider(), crossrefProvider(tools.openAlexMailto), hackerNewsProvider(), stackExchangeProvider(), githubProvider(), githubIssuesProvider(), duckDuckGoProvider()];
	if (tools.braveApiKey) defaults.push(braveProvider(tools.braveApiKey));
	if (tools.searchProviders?.length) {
		const wanted = new Set(tools.searchProviders);
		const optional: SearchProvider[] = [redditProvider()];
		return [...defaults, ...optional].filter((p) => wanted.has(p.name));
	}
	return defaults;
}
