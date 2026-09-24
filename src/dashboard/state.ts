import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CurrentGoal } from "../m07/types.ts";
import { summarizeGoalExecution } from "../m07/status.ts";
import type { StageRunRecord } from "../types.ts";
import { Workspace } from "../workspace.ts";
import { listTelemetry, type SessionTelemetry } from "./telemetry.ts";
import type { DashboardEdge, DashboardNode, DashboardState, DashboardWorkspaceSummary } from "./types.ts";

const STAGES = ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"];

function workspaceInfo(root: string): DashboardWorkspaceSummary {
	const label = path.basename(root) || "workspace";
	return { id: createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16), label, initialized: existsSync(path.join(root, ".agent")) };
}

export async function discoverWorkspaces(options: { root: string; explicitWorkspace?: string }): Promise<DashboardWorkspaceSummary[]> {
	const roots = new Set<string>();
	if (options.explicitWorkspace) roots.add(path.resolve(options.explicitWorkspace));
	const root = path.resolve(options.root);
	if (existsSync(path.join(root, ".agent"))) roots.add(root);
	try {
		for (const item of await readdir(root, { withFileTypes: true })) if (item.isDirectory() && existsSync(path.join(root, item.name, ".agent"))) roots.add(path.join(root, item.name));
	} catch { /* absence is an empty discovery result */ }
	return [...roots].sort().map(workspaceInfo);
}

function fresh(record: SessionTelemetry, now: number, freshnessMs: number): boolean {
	const seen = Date.parse(record.lastSeenAt);
	return Number.isFinite(seen) && now - seen <= freshnessMs;
}

function telemetryNode(record: SessionTelemetry, now: number, freshnessMs: number): DashboardNode {
	const isFresh = fresh(record, now, freshnessMs);
	const activity = record.activity === "ended" ? "ended" : isFresh ? record.activity : "unknown";
	const displayGroup = activity === "ended" ? "archived" : activity === "active" ? "active" : activity === "idle" ? "idle" : "unknown";
	return {
		id: `${record.kind}:${record.id}`, kind: record.kind, label: record.label, role: record.role, model: record.model,
		stage: record.stage, runId: record.runId, activity, displayGroup,
		status: activity === "ended" ? "archived" : activity,
		startedAt: record.startedAt, lastSeenAt: record.lastSeenAt, endedAt: record.endedAt, tools: record.tools, outcome: record.outcome,
	};
}

async function runs(ws: Workspace): Promise<StageRunRecord[]> {
	const result: StageRunRecord[] = [];
	for (const stage of STAGES) for (const runId of await ws.listRuns(stage)) {
		try { result.push(await ws.readRun(stage, runId)); } catch { /* malformed records are omitted, not repaired */ }
	}
	return result;
}

async function legacySpecNodes(ws: Workspace, knownIds: Set<string>): Promise<DashboardNode[]> {
	let names: string[];
	try { names = await readdir(ws.sessionsDir); } catch { return []; }
	const nodes: DashboardNode[] = [];
	for (const name of names.filter((item) => item.endsWith(".spec.json")).sort()) {
		const match = name.match(/^(.+)_([^_]+)\.spec\.json$/);
		if (!match || knownIds.has(match[2])) continue;
		try {
			const raw = JSON.parse(await readFile(path.join(ws.sessionsDir, name), "utf8")) as Record<string, unknown>;
			if (typeof raw.label !== "string" || typeof raw.role !== "string" || typeof raw.model !== "string") continue;
			nodes.push({ id: `agent:${match[2]}`, kind: "agent", label: raw.label, role: raw.role, model: raw.model,
				status: "unknown", activity: "unknown", displayGroup: "unknown", startedAt: match[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z") });
		} catch { /* malformed specs are ignored without reading transcript JSONL */ }
	}
	return nodes;
}

export async function readDashboardState(workspace: Workspace | string, options: { now?: Date; freshnessMs?: number } = {}): Promise<DashboardState> {
	const ws = typeof workspace === "string" ? new Workspace(path.resolve(workspace)) : workspace;
	const now = options.now?.getTime() ?? Date.now();
	const freshnessMs = options.freshnessMs ?? 15_000;
	const allRuns = await runs(ws);
	const telemetry = await listTelemetry(ws.root);
	const telemetryById = new Map(telemetry.map((item) => [item.id, item]));
	const nodes: DashboardNode[] = [];
	const edges: DashboardEdge[] = [];
	const agentIds = new Set<string>();

	for (const run of allRuns) {
		const stageId = `stage:${run.stage}:${run.runId}`;
		const warning = run.status === "completed" && run.failures.length > 0;
		nodes.push({ id: stageId, kind: "stage", label: `${run.stage} ${run.runId}`, stage: run.stage, runId: run.runId,
			status: warning ? "warning" : run.status === "running" ? "unknown" : run.status,
			activity: run.status === "running" ? "unknown" : "ended", displayGroup: run.status === "running" ? "unknown" : "archived",
			startedAt: run.startedAt, endedAt: run.finishedAt, failureCount: run.failures.length });
		for (const session of run.sessions) {
			const item = telemetryById.get(session.id);
			const node = item ? telemetryNode(item, now, freshnessMs) : {
				id: `agent:${session.id}`, kind: "agent" as const, label: session.label, role: session.role, model: session.model,
				stage: run.stage, runId: run.runId,
				status: run.status === "running" ? "unknown" as const : "archived" as const,
				activity: run.status === "running" ? "unknown" as const : "ended" as const,
				displayGroup: run.status === "running" ? "unknown" as const : "archived" as const,
			};
			// A resumed session can retain a historical membership edge from a completed
			// run while fresh telemetry explicitly points at its current run. Historical
			// parents must not overwrite that current lifecycle.
			const belongsHereNow = !item?.stage || !item?.runId || (item.stage === run.stage && item.runId === run.runId);
			if (run.status !== "running" && belongsHereNow) { node.status = "archived"; node.activity = "ended"; node.displayGroup = "archived"; node.endedAt ??= run.finishedAt; }
			nodes.push(node); agentIds.add(session.id);
			edges.push({ id: `${stageId}->${node.id}`, source: stageId, target: node.id, relation: "membership" });
		}
		if (run.stage === "M07") {
			try {
				const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", run.runId), "goal.json"), "utf8")) as CurrentGoal;
				const execution = summarizeGoalExecution(goal);
				const stageNode = nodes.find((node) => node.id === stageId)!;
				Object.assign(stageNode, execution);
				stageNode.label = `M07 ${run.runId} · ${execution.attemptId ?? "legacy"} ${execution.attemptState}`;
				for (const task of goal.tasks) if (task.session && !run.sessions.some((s) => s.id === task.session!.id)) {
					const session = task.session; const item = telemetryById.get(session.id);
					const node = item ? telemetryNode({ ...item, stage: "M07", runId: run.runId }, now, freshnessMs) : {
						id: `agent:${session.id}`, kind: "agent" as const, label: session.label, role: session.role, model: session.model, stage: "M07", runId: run.runId,
						status: task.status === "running" ? "unknown" as const : "archived" as const, activity: task.status === "running" ? "unknown" as const : "ended" as const,
						displayGroup: task.status === "running" ? "unknown" as const : "archived" as const,
					};
					nodes.push(node); agentIds.add(session.id); edges.push({ id: `${stageId}->${node.id}`, source: stageId, target: node.id, relation: "membership" });
				}
			} catch { /* goal is optional for legacy/malformed M07 runs */ }
		}
	}
	for (const item of telemetry) if (!agentIds.has(item.id)) {
		const node = telemetryNode(item, now, freshnessMs);
		nodes.push(node);
		if (item.stage && item.runId && allRuns.some((run) => run.stage === item.stage && run.runId === item.runId)) {
			const stageId = `stage:${item.stage}:${item.runId}`;
			edges.push({ id: `${stageId}->${node.id}`, source: stageId, target: node.id, relation: "membership" });
		}
	}
	for (const node of await legacySpecNodes(ws, new Set(nodes.filter((item) => item.kind === "agent").map((item) => item.id.slice("agent:".length))))) nodes.push(node);
	for (const node of nodes.filter((item) => item.kind === "stage" && item.status === "unknown")) {
		if (node.stage === "M07" && node.attemptState && node.attemptState !== "running" && node.attemptState !== "legacy-untracked") continue;
		const memberIds = new Set(edges.filter((edge) => edge.source === node.id && edge.relation === "membership").map((edge) => edge.target));
		const members = nodes.filter((item) => memberIds.has(item.id));
		if (members.some((item) => item.activity === "active")) { node.status = "active"; node.activity = "active"; node.displayGroup = "active"; }
		else if (members.some((item) => item.activity === "idle")) { node.status = "idle"; node.activity = "idle"; node.displayGroup = "idle"; }
	}
	const uniqueNodes = new Map<string, DashboardNode>();
	for (const node of nodes) {
		const previous = uniqueNodes.get(node.id);
		if (!previous) { uniqueNodes.set(node.id, node); continue; }
		// One persisted session may be resumed by multiple real runs. Keep one node
		// and all membership edges, without pretending it belongs uniquely to either run.
		uniqueNodes.set(node.id, { ...previous, ...(previous.stage === node.stage && previous.runId === node.runId ? {} : { stage: undefined, runId: undefined }) });
	}
	return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), workspace: workspaceInfo(ws.root),
		nodes: [...uniqueNodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
		limitations: ["Fresh heartbeat is the only evidence of live activity; stale legacy running records remain unknown.", "M07 run status and attempt state are independent; a running run can have a suspended or recovery-required attempt.", "Edges express persisted membership only and do not imply a single causal research path."],
	};
}
