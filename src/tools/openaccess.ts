/**
 * Open-access lookup for paywalled works. The workflow forbids buying material and forbids
 * bypassing access controls; the only allowed move is to find a legitimately open version
 * (author manuscript, preprint, repository copy). OpenAlex reports those locations.
 */
import { fetchJson } from "./http.ts";
import { openAlexHit } from "./search.ts";

export interface OpenAccessResult {
	input: string;
	kind: "doi" | "arxiv" | "unknown";
	found: boolean;
	isOa?: boolean;
	oaUrl?: string;
	landingUrl?: string;
	license?: string;
	title?: string;
	warnings: string[];
}

export function detectIdentifier(input: string): { kind: "doi" | "arxiv" | "unknown"; id: string } {
	const trimmed = input.trim();
	const doi = /10\.\d{4,9}\/[^\s"<>]+/i.exec(trimmed)?.[0];
	if (doi) return { kind: "doi", id: doi.replace(/[.,;)]+$/, "") };
	const arxiv = /(?:arxiv\.org\/(?:abs|pdf)\/|arXiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(trimmed);
	if (arxiv && /arxiv|^\d{4}\.\d{4,5}(v\d+)?$/i.test(trimmed)) return { kind: "arxiv", id: arxiv[1] };
	return { kind: "unknown", id: trimmed };
}

export async function findOpenAccess(input: string, mailto?: string): Promise<OpenAccessResult> {
	const { kind, id } = detectIdentifier(input);
	if (kind === "arxiv") {
		return { input, kind, found: true, isOa: true, oaUrl: `https://arxiv.org/pdf/${id}`, landingUrl: `https://arxiv.org/abs/${id}`, license: undefined, warnings: [] };
	}
	if (kind !== "doi") return { input, kind, found: false, warnings: ["未识别出 DOI 或 arXiv 标识；请提供 DOI、arXiv 地址或先用检索找到标识"] };
	const params = mailto ? `?mailto=${encodeURIComponent(mailto)}` : "";
	try {
		const work = await fetchJson<Parameters<typeof openAlexHit>[0] & { open_access?: { is_oa?: boolean } }>(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(id)}${params}`);
		const hit = openAlexHit(work);
		return {
			input,
			kind,
			found: true,
			isOa: Boolean(work.open_access?.is_oa),
			oaUrl: hit.oaUrl,
			landingUrl: hit.url,
			license: work.best_oa_location?.license ?? undefined,
			title: hit.title,
			warnings: hit.oaUrl ? [] : ["OpenAlex 未登记开放版本；可尝试作者主页或机构知识库，不得购买或绕过付费墙"],
		};
	} catch (error) {
		return { input, kind, found: false, warnings: [`OpenAlex 查询失败：${(error as Error).message}`] };
	}
}
