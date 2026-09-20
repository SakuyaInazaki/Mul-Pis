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
}

export interface SearchProvider {
	name: string;
	description: string;
	search(query: string, options: { limit: number }): Promise<SearchOutcome>;
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

export function openAlexProvider(mailto?: string): SearchProvider {
	return {
		name: "openalex",
		description: "OpenAlex 学术文献检索：DOI、发表信息与开放获取地址",
		async search(query, { limit }) {
			const params = new URLSearchParams({ search: query, "per-page": String(Math.min(limit, 50)), select: "id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,open_access,best_oa_location" });
			if (mailto) params.set("mailto", mailto);
			const data = await fetchJson<{ results?: OpenAlexWork[] }>(`https://api.openalex.org/works?${params.toString()}`);
			return { provider: "openalex", query, limit, hits: (data.results ?? []).map(openAlexHit), warnings: [], endpoint: "https://api.openalex.org/works" };
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

export function arxivProvider(): SearchProvider {
	return {
		name: "arxiv",
		description: "arXiv 预印本检索：标题、摘要、发布日期与 PDF 地址",
		async search(query, { limit }) {
			const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query}`)}&max_results=${Math.min(limit, 50)}`;
			const { text, status } = await fetchText(url);
			if (status !== 200) return { provider: "arxiv", query, limit, hits: [], warnings: [`arXiv 返回 HTTP ${status}`], endpoint: "https://export.arxiv.org/api/query" };
			return { provider: "arxiv", query, limit, hits: parseArxivAtom(text), warnings: [], endpoint: "https://export.arxiv.org/api/query" };
		},
	};
}

/* ------------------------------------------------------------------ communities (official keyless APIs) */

export function hackerNewsProvider(): SearchProvider {
	return {
		name: "hackernews",
		description: "Hacker News 讨论检索（Algolia 官方接口）",
		async search(query, { limit }) {
			const data = await fetchJson<{ hits?: Array<{ title?: string; story_title?: string; url?: string; objectID?: string; created_at?: string; points?: number; num_comments?: number; comment_text?: string; story_text?: string }> }>(
				`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(limit, 50)}`,
			);
			const hits: SearchHit[] = (data.hits ?? []).map((h) => ({
				provider: "hackernews",
				title: clean(h.title ?? h.story_title),
				url: `https://news.ycombinator.com/item?id=${h.objectID}`,
				snippet: clean([h.url ? `外链：${h.url}` : "", h.story_text ?? h.comment_text ?? ""].filter(Boolean).join(" ")).slice(0, 400),
				date: h.created_at,
				venue: `HN ${h.points ?? 0} 分 / ${h.num_comments ?? 0} 评论`,
			}));
			return { provider: "hackernews", query, limit, hits, warnings: [], endpoint: "https://hn.algolia.com/api/v1/search" };
		},
	};
}

export function stackExchangeProvider(site: string = "stackoverflow"): SearchProvider {
	return {
		name: "stackexchange",
		description: "Stack Exchange 问答检索（官方接口，默认 stackoverflow，可用 site: 前缀指定站点，如 site:physics）",
		async search(query, { limit }) {
			const m = /^site:(\S+)\s+/.exec(query);
			const target = m ? m[1] : site;
			const q = m ? query.slice(m[0].length) : query;
			const data = await fetchJson<{ items?: Array<{ title?: string; link?: string; creation_date?: number; score?: number; answer_count?: number; is_answered?: boolean; tags?: string[] }>; quota_remaining?: number }>(
				`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=${encodeURIComponent(target)}&pagesize=${Math.min(limit, 50)}`,
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
			return { provider: "stackexchange", query, limit, hits, warnings, endpoint: "https://api.stackexchange.com/2.3/search/advanced" };
		},
	};
}

export function redditProvider(): SearchProvider {
	return {
		name: "reddit",
		description: "Reddit 帖子检索（公开 JSON 接口，无密钥时限流较严）",
		async search(query, { limit }) {
			const data = await fetchJson<{ data?: { children?: Array<{ data?: { title?: string; permalink?: string; subreddit?: string; created_utc?: number; score?: number; num_comments?: number; selftext?: string; url?: string } }> } }>(
				`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}&sort=relevance`,
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
			return { provider: "reddit", query, limit, hits, warnings: hits.length ? [] : ["Reddit 未返回结果；无密钥访问可能被限流或要求登录"], endpoint: "https://www.reddit.com/search.json" };
		},
	};
}

export function githubProvider(): SearchProvider {
	return {
		name: "github",
		description: "GitHub 仓库检索（官方接口，无密钥每分钟约 10 次）",
		async search(query, { limit }) {
			const data = await fetchJson<{ items?: Array<{ full_name?: string; html_url?: string; description?: string | null; stargazers_count?: number; pushed_at?: string; language?: string | null }> }>(
				`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 50)}`,
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
			return { provider: "github", query, limit, hits, warnings: [], endpoint: "https://api.github.com/search/repositories" };
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

export function duckDuckGoProvider(): SearchProvider {
	return {
		name: "duckduckgo",
		description: "DuckDuckGo 通用网页检索（无需密钥的公开 HTML 接口；尽力而为，可能限流）",
		async search(query, { limit }) {
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
			const { text, status } = await fetchText(url, { headers: { accept: "text/html" } });
			const warnings: string[] = ["非官方 API：结果来自公开 HTML 页面，可能不稳定或被限流"];
			if (status !== 200) return { provider: "duckduckgo", query, limit, hits: [], warnings: [...warnings, `HTTP ${status}`], endpoint: "https://html.duckduckgo.com/html/" };
			const hits = parseDuckDuckGoHtml(text).slice(0, limit);
			if (!hits.length && /anomaly|captcha|bot/i.test(text)) warnings.push("DuckDuckGo 返回了人机验证页，本次无结果");
			return { provider: "duckduckgo", query, limit, hits, warnings, endpoint: "https://html.duckduckgo.com/html/" };
		},
	};
}

export function braveProvider(apiKey: string): SearchProvider {
	return {
		name: "brave",
		description: "Brave Search API 通用网页检索（需用户提供密钥）",
		async search(query, { limit }) {
			const data = await fetchJson<{ web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> } }>(
				`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`,
				{ headers: { "X-Subscription-Token": apiKey, accept: "application/json" } },
			);
			const hits: SearchHit[] = (data.web?.results ?? []).map((r) => ({ provider: "brave", title: clean(r.title), url: r.url ?? "", snippet: decodeEntities(clean(r.description).replace(/<[^>]+>/g, "")).slice(0, 300), date: r.page_age?.slice(0, 10) ?? r.age }));
			return { provider: "brave", query, limit, hits, warnings: [], endpoint: "https://api.search.brave.com/res/v1/web/search" };
		},
	};
}

/**
 * Providers available under a config: scholarly + community + keyless general web, plus Brave when a
 * key is configured. Reddit is opt-in only (its public JSON search answers 403 to unauthenticated
 * clients as of 2026-09-20). `tools.searchProviders` restricts the set (by name) when present.
 */
export function providersFor(tools: ToolsConfig): SearchProvider[] {
	const defaults: SearchProvider[] = [openAlexProvider(tools.openAlexMailto), arxivProvider(), hackerNewsProvider(), stackExchangeProvider(), githubProvider(), duckDuckGoProvider()];
	if (tools.braveApiKey) defaults.push(braveProvider(tools.braveApiKey));
	if (tools.searchProviders?.length) {
		const wanted = new Set(tools.searchProviders);
		const optional: SearchProvider[] = [redditProvider()];
		return [...defaults, ...optional].filter((p) => wanted.has(p.name));
	}
	return defaults;
}
