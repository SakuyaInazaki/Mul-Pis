/**
 * Workspace initialisation (P00R for references/ plus the knowledge store layout).
 * Creates rules and empty directories only. Does not search, download, invent
 * sources or write a config: models are the user's choice.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE } from "../config.ts";
import type { KnowledgeStore } from "../knowledge/types.ts";
import { nowIso, writeFileAtomic, type Workspace } from "../workspace.ts";

export interface InitResult {
	created: string[];
	kept: string[];
	configMissing: boolean;
}

export const CONFIG_TEMPLATE = `{
	  "roles": {
    "execution": "provider/model:thinking",
    "reviewer": "provider/model:thinking",
    "research": "provider/model:thinking",
    "reader": "provider/model",
    "checker": "provider/model",
    "applicability": "provider/model",
    "improver": "provider/model:thinking"
	  },
	  "m03Reviewers": [
	    { "id": "R1", "model": "provider/model:thinking" }
	  ],
  "concurrency": 1
}
`;

export async function runInit(ws: Workspace, store: KnowledgeStore): Promise<InitResult> {
	const created: string[] = [];
	const kept: string[] = [];
	for (const dir of [path.join(ws.root, "problem", "raw"), ws.stagesDir, ws.sessionsDir, ws.notesDir]) {
		if (existsSync(dir)) kept.push(path.relative(ws.root, dir) + "/");
		else {
			await mkdir(dir, { recursive: true });
			created.push(path.relative(ws.root, dir) + "/");
		}
	}
	const refs = await ws.initReferences();
	created.push(...refs.created);
	kept.push(...refs.kept);
	await store.init();
	const configMissing = !existsSync(ws.configFile);
	const notePath = path.join(ws.notesDir, `${nowIso().slice(0, 10)}-init.md`);
	if (!existsSync(notePath)) {
		await writeFileAtomic(
			notePath,
			`# 工作区初始化\n\n- 时间：${nowIso()}\n- 新建：${created.join("、") || "无"}\n- 保留：${kept.join("、") || "无"}\n- 未搜索、未下载、未创建示例来源；未写入 ${CONFIG_FILE}（模型由用户指定）。\n`,
		);
	}
	return { created, kept, configMissing };
}
