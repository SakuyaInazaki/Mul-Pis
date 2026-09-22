/**
 * M04 纠错、知识记录与状态更新.
 *
 * Boundary (foundation, M04 本轮已对齐): the main agent organises, the research
 * session does the substantive judgement. The first round may continue the M01
 * session; later rounds use a fresh research session that only receives the
 * current knowledge pack, the feedback and the artifact locations. One feedback
 * batch is the minimal unit. Proposals are validated structurally and merged
 * through the single serial entry; merging is never a truth certificate.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ProposalOp } from "../knowledge/types.ts";
import { buildM04Message, extractKnowledgeProposals, systemPromptFor } from "../prompts.ts";
import type { ProblemMaterials } from "../prompts.ts";
import { HarnessError, type InputRef, type StageRunRecord } from "../types.ts";
import { readTextIfExists } from "../workspace.ts";
import { loadProblemMaterials, readOutput, recordSession, relPath, requireCompletedRun, sessionSpec, withRun, type StageContext } from "./context.ts";
import { specFileFor } from "./m03.ts";
import { readFrozenArtifactManifest, type FrozenArtifactManifest } from "./artifacts.ts";
import { renderPageTool } from "../tools/pagetool.ts";

export type M04Feedback =
	| { kind: "M03"; runId?: string }
	| { kind: "M06"; runId?: string }
	| { kind: "M07"; runId?: string }
	| { kind: "M08"; runId?: string }
	| { kind: "file"; label: string; path: string };

export interface M04Options {
	feedback: M04Feedback;
	/** Force a fresh research session even if the first round could continue M01. */
	freshSession?: boolean;
	/** Purpose string recorded in the knowledge pack. */
	purpose?: string;
}

export interface M04Result {
	record: StageRunRecord;
	output: string;
	proposalId?: string;
	snapshotId?: string;
	mode: "continue-m01" | "research-session";
}

interface ResolvedFeedback {
	label: string;
	text: string;
	inputs: InputRef[];
	artifactPaths: string[];
	m08?: { runId: string; manifest: FrozenArtifactManifest; manifestPath: string };
	m07?: { runId: string; rootDir: string };
}

async function resolveFeedback(ctx: StageContext, feedback: M04Feedback): Promise<ResolvedFeedback> {
	if (feedback.kind === "M03") {
		const run = await requireCompletedRun(ctx, "M03", feedback.runId);
		const evaluation = await readOutput(run, "逐题评价");
		const questions = await readOutput(run, "可转发问题");
		const answers = await readOutput(run, "执行会话完整回答");
		return {
			label: `M03 外部评价（运行 ${run.runId}）`,
			text: `${evaluation.text}\n\n【本轮质询问题（供定位）】\n${questions.text}`,
			inputs: [
				{ label: "M03 逐题评价", path: evaluation.path },
				{ label: "M03 可转发问题", path: questions.path },
				{ label: "M03 完整回答", path: answers.path },
			],
			artifactPaths: [relPath(ctx, evaluation.path), relPath(ctx, questions.path), relPath(ctx, answers.path)],
		};
	}
	if (feedback.kind === "M06") {
		const run = await requireCompletedRun(ctx, "M06", feedback.runId);
		const summary = await readOutput(run, "整批汇总");
		return {
			label: `M06 整批材料处理建议（运行 ${run.runId}）`,
			text: summary.text,
			inputs: [{ label: "M06 整批汇总", path: summary.path }, ...run.outputs.filter((o) => o.label !== "整批汇总").map((o) => ({ label: `M06 ${o.label}`, path: o.path }))],
			artifactPaths: run.outputs.map((o) => relPath(ctx, o.path)),
		};
	}
	if (feedback.kind === "M07") {
		let run: StageRunRecord;
		if (feedback.runId) run = await ctx.ws.readRun("M07", feedback.runId);
		else {
			const ids = await ctx.ws.listRuns("M07");
			if (!ids.length) throw new HarnessError("run.missing", "没有 M07 运行");
			run = await ctx.ws.readRun("M07", ids.at(-1)!);
		}
		if (run.status === "running") throw new HarnessError("run.incomplete", `M07 运行 ${run.runId} 尚未结束，不能作为输入`);
		const bundle = await readOutput(run, "M07 实际执行反馈包");
		return {
			label: `M07 实际执行反馈（运行 ${run.runId}）`,
			text: bundle.text,
			inputs: [{ label: "M07 实际执行反馈包", path: bundle.path }, ...run.outputs.filter((o) => o.label !== "M07 实际执行反馈包").map((o) => ({ label: `M07 ${o.label}`, path: o.path }))],
			artifactPaths: run.outputs.map((o) => relPath(ctx, o.path)),
			m07: { runId: run.runId, rootDir: ctx.ws.runDir("M07", run.runId) },
		};
	}
	if (feedback.kind === "M08") {
		const run = await requireCompletedRun(ctx, "M08", feedback.runId);
		const bundle = await readOutput(run, "M08 审查反馈包");
		const manifestRef = run.outputs.find((o) => o.label === "固定材料清单");
		if (!manifestRef) throw new HarnessError("m04.m08", `M08 运行 ${run.runId} 缺少固定材料清单`);
		const manifest = await readFrozenArtifactManifest(manifestRef.path, { m08RunId: run.runId, rootDir: path.join(ctx.ws.runDir("M08", run.runId), "frozen") });
		return {
			label: `M08 完整审查反馈（运行 ${run.runId}）`, text: bundle.text,
			inputs: [{ label: `M08 审查反馈包（运行 ${run.runId}）`, path: bundle.path }, { label: `M08 固定材料清单（运行 ${run.runId}）`, path: manifestRef.path }, ...run.outputs.filter((o) => /完整报告|实际读取范围|核验工具记录/.test(o.label)).map((o) => ({ label: `M08 ${o.label}`, path: o.path }))],
			artifactPaths: manifest.entries.map((x) => x.relativePath), m08: { runId: run.runId, manifest, manifestPath: manifestRef.path },
		};
	}
	const text = await readTextIfExists(feedback.path);
	if (!text) throw new HarnessError("m04.feedback", `找不到意见文件 ${feedback.path}`);
	return { label: feedback.label, text, inputs: [{ label: feedback.label, path: feedback.path }], artifactPaths: [relPath(ctx, feedback.path)] };
}

export async function runM04(ctx: StageContext, options: M04Options): Promise<M04Result> {
	const feedback = await resolveFeedback(ctx, options.feedback);
	let materials: ProblemMaterials;
	let problemInputs: InputRef[];
	if (feedback.m08) {
		const fixedProblem = feedback.m08.manifest.entries.find((x) => x.sourceCategory === "original-problem");
		if (!fixedProblem) throw new HarnessError("m04.m08", "M08 固定材料缺少原问题");
		const fixedProblemText = await readTextIfExists(fixedProblem.frozenPath);
		if (fixedProblemText === undefined || !fixedProblemText.trim()) throw new HarnessError("m04.m08", "M08 固定原问题缺失或为空");
		materials = { problem: fixedProblemText, rawInfo: [] };
		for (const item of feedback.m08.manifest.entries.filter((x) => x.sourceCategory === "raw-input")) {
			const content = await readTextIfExists(item.frozenPath);
			if (content === undefined) throw new HarnessError("m04.m08", `M08 固定原始信息缺失：${item.relativePath}`);
			materials.rawInfo.push({ name: item.label, content });
		}
		problemInputs = [{ label: `M08 固定原始问题（运行 ${feedback.m08.runId}）`, path: fixedProblem.frozenPath }, ...feedback.m08.manifest.entries.filter((x) => x.sourceCategory === "raw-input").map((x) => ({ label: x.label, path: x.frozenPath }))];
	} else ({ materials, inputs: problemInputs } = await loadProblemMaterials(ctx.ws));
	const snapshot = await ctx.store.current();
	const previousM04 = await ctx.ws.latestCompletedRun("M04");
	const m01 = await ctx.ws.latestCompletedRun("M01");
	const m01Session = m01?.sessions.find((s) => s.label === "M01");
	const continueM01 = feedback.label.startsWith("M07 ") || feedback.m08 ? false : !options.freshSession && !previousM04 && !!m01Session?.file;
	const mode: M04Result["mode"] = continueM01 ? "continue-m01" : "research-session";

	const record = await ctx.ws.startRun("M04", [...problemInputs, ...feedback.inputs], snapshot?.id);
	record.remarks.push(mode === "continue-m01" ? "首轮 M04：续接 M01 原会话。" : "新建研究会话，只读取当前知识包、意见与实际产物位置。");

	return withRun(
		ctx,
		record,
		async () => {
			if (feedback.m07) await ctx.ws.writeOutput(record, "m07-source.json", JSON.stringify({ m07RunId: feedback.m07.runId, rootDir: feedback.m07.rootDir, feedbackBundlePath: feedback.inputs[0].path }, null, 2), "M07 处理来源");
			if (feedback.m08) await ctx.ws.writeOutput(record, "m08-source.json", JSON.stringify({ m08RunId: feedback.m08.runId, manifestPath: feedback.m08.manifestPath, reviewBundlePath: feedback.inputs[0].path }, null, 2), "M08 处理来源");
			let knowledgePack: string | undefined;
			if (mode === "research-session") {
				const pack = await ctx.store.buildPack({ purpose: options.purpose ?? `M04 处理：${feedback.label}`, includeOpenQuestions: true, types: ["C", "K", "E", "J", "Q", "D", "X"], maxChars: 60_000 });
				knowledgePack = pack.markdown;
				await ctx.ws.writeOutput(record, "knowledge-pack.md", pack.markdown, "提供给研究会话的局部知识包");
				if (pack.truncated) record.remarks.push(`知识包按长度截断，未展开：${pack.omitted.join(", ")}`);
			}
			const identityContract = `\n\n【知识记录身份契约】\n- 只有上方局部知识包明确列出的 ID 才能直接引用为已有记录；意见、报告或历史正文中的 C001/J001/E001 等字样可能只是叙述标签，不得猜测或映射成知识库 ID。\n- 本批新建记录如需互相引用，每个 create 先声明唯一局部 handle（如 \"handle\":\"$claim\"），后续操作可用 \"refs\":[{\"rel\":\"supports\",\"target\":\"$claim\"}] 或将 decide/limit 的目标写为 $claim。只引用已在同一数组更早创建的 handle；handle 仅在本提案内有效，合入时才分配正式 ID。\n- 局部包可能截断或没有展开相关旧记录。需修订、决定或限制但看不到对应 ID 时，先请求补足相关记录或保留待补证，不得重建重复记录或绕过旧限制。只有确认是全新对象时才用 handle 新建；不伪造 ID。`;
			const message = (await buildM04Message({ materials, feedbackLabel: feedback.label, feedback: feedback.text, artifactPaths: feedback.artifactPaths, knowledgePack, includeProblem: mode === "research-session" })) + identityContract;

			const allowedM08Paths = feedback.m08?.manifest.entries.map((x) => x.relativePath) ?? [];
			const m08DispositionInstruction = feedback.m08 ? `\n\n【M08 固定材料访问契约】\n上方审查反馈包只是意见汇总，“实际产物位置”也只是索引；它们不表示你已读取待交付材料。若要给出 ready 或 partial，必须在本会话中用 m08_material_read 按下列精确 relativePath 实际读取每一项准备写入 deliverablePaths 的文件；目录项至少读取其中一个与处置直接相关的真实文件。PDF 文本层不足以核对公式、表格或图时，用 render_pdf_page 渲染相关页。工具会记录实际访问路径，仅在正文里复述或引用路径不算读取。\n可访问的固定材料：${allowedM08Paths.map((p) => `\n- ${p}`).join("")}\n\n本轮必须在处理文末尾输出 m08-disposition JSON 代码块。合法 status 只有 ready、partial、rework、needs_evidence、unresolved。结构示例：{\"m08RunId\":\"${feedback.m08.runId}\",\"status\":\"partial\",\"deliverablePaths\":[\"上述某一精确 relativePath\"],\"limitations\":[\"实际限制\"],\"rationale\":\"非空理由\"}。deliverablePaths 只允许从上述精确相对路径选择。ready/partial 必须至少选择一项；这是用途处置，不是投票或科学认证；无法判断不得写 ready。` : "";
			const m07EvidenceInstruction = feedback.m07 ? `\n\n【M07 证据按需读取契约】\n上方反馈包中的材料清单是索引，不代表你已读取未内联的证据。需要依赖某项材料时，使用 m07_evidence_read 按清单中的相对路径读取；大文件按 offset/limit 继续读取。工具记录文件访问，但当前覆盖记录只能证明访问过该文件，不能证明读取了全文；除非实际分段读至文件末尾，否则必须把未读范围列为限制。不得把路径存在、清单摘要或一次局部读取写成“已完整核验”。` : "";
			const finalMessage = message + m08DispositionInstruction + m07EvidenceInstruction;
			await ctx.ws.writeOutput(record, "message.md", finalMessage, "发送给研究会话的完整消息");
			if (feedback.m08) await ctx.ws.writeOutput(record, "m08-message.md", finalMessage, "发送给 M04 的固定 M08 消息");
			const m08RenderedPages: string[] = [];
			const m08PageTool = feedback.m08 ? renderPageTool({ root: feedback.m08.manifest.rootDir, outputDir: path.join(ctx.ws.runDir("M04", record.runId), "rendered-pages"), tools: ctx.config.tools, onRendered: ({ pdf, page }) => { m08RenderedPages.push(`${path.relative(feedback.m08!.manifest.rootDir, pdf)}#${page}`); } }) : undefined;
			const feedbackTools = feedback.m08
				? { kind: "read-dir" as const, root: feedback.m08.manifest.rootDir, toolName: "m08_material_read", extraTools: [m08PageTool!] }
				: feedback.m07
					? { kind: "read-dir" as const, root: feedback.m07.rootDir, toolName: "m07_evidence_read" }
					: { kind: "none" as const };
			const handle =
				mode === "continue-m01" && m01Session?.file
					? await ctx.runner.resume({ label: "M01", role: "execution", id: m01Session.id, model: m01Session.model, file: m01Session.file, specFile: specFileFor(m01Session.file) })
					: await ctx.runner.create(sessionSpec(ctx, "M04-research", "research", systemPromptFor("research"), feedbackTools));
			let output: string;
			let m08ReadCoverage: string[] = [];
			let m08ToolLog: ReturnType<typeof handle.toolLog> = [];
			try {
				recordSession(record, handle);
				const turn = await handle.prompt(finalMessage);
				output = turn.text;
				m08ReadCoverage = handle.readCoverage();
				m08ToolLog = handle.toolLog();
				await ctx.ws.writeOutput(record, "processing.md", output, "处理结果");
			} finally {
				handle.dispose();
			}
			if (feedback.m08) await ctx.ws.writeOutput(record, "m08-coverage.json", JSON.stringify({ files: m08ReadCoverage, renderedPages: m08RenderedPages, tools: m08ToolLog }, null, 2), "M08 处理实际读取范围");
			if (feedback.m07) await ctx.ws.writeOutput(record, "m07-coverage.json", JSON.stringify({ filesAccessed: m08ReadCoverage, completeness: "unknown", semantics: "文件名仅证明工具访问过该文件；不证明已读全文。读取范围需结合会话报告中的 offset/limit 声明核对。" }, null, 2), "M07 回流证据实际访问范围");

			const result: M04Result = { record, output, mode };
			if (feedback.m08) {
				const disposition = await requireDispositionEvidence(parseM08Disposition(output, feedback.m08), feedback.m08.manifest, m08ReadCoverage, m08RenderedPages);
				await ctx.ws.writeOutput(record, "m08-disposition.json", JSON.stringify(disposition, null, 2), "M08 用途处置");
				if (disposition.status === "unresolved") record.failures.push(`M08 处置缺失、非法或缺少实际材料访问依据，已保守记录为 unresolved；不能供 M09 收口。${disposition.limitations.join("；")}`);
			}
			const extracted = extractKnowledgeProposals(output);
			if (extracted.error) {
				record.failures.push(`知识提案未入库：${extracted.error}`);
			} else if (extracted.ops) {
				const receipt = await ctx.store.submitProposal({ stage: "M04", runId: record.runId, session: handle.ref.label, baseSnapshot: snapshot?.id, ops: extracted.ops as ProposalOp[], summary: feedback.label });
				result.proposalId = receipt.proposalId;
				record.outputs.push({ label: "知识提案", path: receipt.file });
				if (receipt.structurallyValid) {
					const merged = await ctx.store.merge(receipt.proposalId);
					result.snapshotId = merged.snapshot.id;
					await ctx.ws.writeOutput(record, "merge.json", JSON.stringify(merged, null, 2), "合入结果");
					record.remarks.push(`已经串行合入，快照 ${merged.snapshot.id}；受影响待复核 ${merged.impacts.length} 项；先行生效的限制 ${merged.limitsWrittenFirst.length} 项。合入不是科学认证。`);
					await ctx.store.regenerateViews();
				} else {
					record.failures.push(`知识提案未合入：结构校验未通过：${receipt.issues.filter((i) => i.level === "error").map((i) => i.message).join("；")}`);
				}
			} else {
				record.remarks.push("本轮没有知识提案；处理结果只以文本保存（没有知识变化也可完成）。");
			}
			return result;
		},
		() =>
			`按 P04 处理“${feedback.label}”。${mode === "continue-m01" ? "续接 M01 原会话" : "新建研究会话并提供局部知识包"}；保存处理结果；如有结构合法的知识提案则经单一串行入口合入并发布快照。意见来源：${feedback.inputs.map((i) => path.basename(i.path)).join("、")}。`,
	);
}

interface M08Disposition { m08RunId: string; status: "ready" | "partial" | "rework" | "needs_evidence" | "unresolved"; deliverablePaths: string[]; limitations: string[]; rationale: string }

async function requireDispositionEvidence(disposition: M08Disposition, manifest: FrozenArtifactManifest, readCoverage: string[], renderedPages: string[]): Promise<M08Disposition> {
	if (disposition.status !== "ready" && disposition.status !== "partial") return disposition;
	const readPaths = readCoverage.map((item) => path.normalize(item));
	const renderedPaths = renderedPages.map((item) => path.normalize(item.replace(/#\d+$/, "")));
	const evidencePaths = [...new Set([...readPaths, ...renderedPaths])];
	const missing: string[] = [];
	for (const deliverablePath of disposition.deliverablePaths) {
		const entry = manifest.entries.find((item) => item.relativePath === deliverablePath)!;
		const relativePath = path.normalize(entry.relativePath);
		if (entry.kind === "file") {
			if (!evidencePaths.includes(relativePath)) missing.push(entry.relativePath);
			continue;
		}
		let foundFile = false;
		for (const candidate of evidencePaths) {
			const within = path.relative(relativePath, candidate);
			if (!within || within.startsWith("..") || path.isAbsolute(within)) continue;
			const absolute = path.resolve(manifest.rootDir, candidate);
			try { if ((await lstat(absolute)).isFile()) { foundFile = true; break; } }
			catch { /* Coverage must resolve to a real frozen file to count. */ }
		}
		if (!foundFile) missing.push(entry.relativePath);
	}
	if (!missing.length) return disposition;
	const reason = `M04 未实际读取或渲染待交付材料：${missing.join("、")}`;
	return { m08RunId: disposition.m08RunId, status: "unresolved", deliverablePaths: [], limitations: [...disposition.limitations, reason], rationale: reason };
}

function parseM08Disposition(text: string, source: NonNullable<ResolvedFeedback["m08"]>): M08Disposition {
	const fallback: M08Disposition = { m08RunId: source.runId, status: "unresolved", deliverablePaths: [], limitations: ["M04 未产生有效的 m08-disposition"], rationale: "结构化用途处置缺失或无效" };
	const match = /```m08-disposition\s*\n([\s\S]*?)```/m.exec(text);
	if (!match) return fallback;
	try {
		const x = JSON.parse(match[1]) as Record<string, unknown>;
		const statuses = ["ready", "partial", "rework", "needs_evidence", "unresolved"];
		if (x.m08RunId !== source.runId || !statuses.includes(String(x.status)) || !Array.isArray(x.deliverablePaths) || !x.deliverablePaths.every((p) => typeof p === "string") || !Array.isArray(x.limitations) || !x.limitations.every((p) => typeof p === "string") || typeof x.rationale !== "string" || !x.rationale.trim()) return fallback;
		const allowed = new Set(source.manifest.entries.map((e) => e.relativePath));
		if (!(x.deliverablePaths as string[]).every((p) => allowed.has(p))) return fallback;
		if ((x.status === "ready" || x.status === "partial") && !(x.deliverablePaths as string[]).length) return fallback;
		return x as unknown as M08Disposition;
	} catch { return fallback; }
}
