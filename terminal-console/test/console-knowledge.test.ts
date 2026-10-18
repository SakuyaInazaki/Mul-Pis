import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowKnowledgeReader, knowledgeStatusLabel } from "../src/console/knowledge.ts";

async function fixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "console-knowledge-"));
}

async function put(root: string, relative: string, value: string | unknown): Promise<void> {
  const file = path.join(root, ".agent", "knowledge", relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

function record(id: string, version: number, body: string, fields: object = {}, usageDecision = "adopted"): string {
  const metadata = { id, type: id[0], version, title: `${id} 标题`, createdAt: "2026-01-01", source: { stage: "M04", runId: "r" }, evidenceStatus: "独立复算", usageDecision, scope: ["X001"], supersedes: null, reason: "修订", qStatus: null, fields, refs: [{ rel: "supports", target: "C001", note: "完整依据" }] };
  return ["---", ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", body].join("\n");
}

test("reads current and historical published versions with full body, fields and live limits without writing", async () => {
  const root = await fixture();
  try {
    await put(root, "CURRENT", "G002\n");
    await put(root, "store-id.json", { version: 1, storeId: "store-1" });
    await put(root, "limits.json", [{ target: "C001", kind: "needs_recheck", reason: "需重新核对", authority: "D001", since: "2026-01-02" }, { target: "K001", kind: "withdrawn", reason: "旧", authority: "D002", since: "2026-01-01", liftedAt: "2026-01-03", liftReason: "恢复" }]);
    await put(root, "snapshots/G001.json", { id: "G001", createdAt: "2026-01-01", records: [{ id: "C001", version: 1 }], activeLimits: [], proposals: ["P0001"] });
    await put(root, "snapshots/G002.json", { id: "G002", createdAt: "2026-01-02", records: [{ id: "C001", version: 2 }, { id: "K001", version: 1 }], activeLimits: ["needs_recheck:C001"], proposals: ["P0002"] });
    const original = "第一行\n\n第二行，完整保留。\n";
    await put(root, "records/C001/v1.md", record("C001", 1, "旧正文", {}, "withdrawn"));
    await put(root, "records/C001/v2.md", record("C001", 2, original, { complex: { evidence: ["甲", "乙"] } }));
    await put(root, "records/K001/v1.md", record("K001", 1, "判据正文"));
    const before = await readdir(path.join(root, ".agent", "knowledge"));
    const reader = new WorkflowKnowledgeReader(root);
    const current = await reader.read();
    assert.equal(current.snapshotId, "G002");
    assert.deepEqual(current.snapshots.map(x => x.id), ["G001", "G002"]);
    assert.equal(current.records.length, 2);
    assert.equal(current.records[0].body, original);
    assert(current.records[0].lines.join("\n").includes("完整依据"));
    assert(current.records[0].lines.join("\n").includes("甲"));
    assert(current.records[0].lines.join("\n").includes("第二行，完整保留。"));
    const detail = current.records[0].lines.join("\n");
    assert(detail.indexOf("本记录直接限制：") < detail.indexOf("正文："));
    assert(detail.indexOf("正文：") < detail.indexOf("完整记录元数据："));
    assert(detail.includes("历史使用决定：历史采用（adopted）"));
    assert(detail.includes("当前单记录可用性：not_allowed"));
    assert(detail.includes("必要依赖闭包与反证适用性须通过知识选择/读取入口核对"));
    assert.equal(knowledgeStatusLabel("withdrawn"), "已撤回");
    assert.equal(current.records[0].activeLimits.length, 1);
    assert.equal(current.records[0].availability?.availability, "not_allowed");
    assert.equal(current.records[1].availability?.availability, "usable_conditionally");
    assert.equal(current.limits.length, 2);
    assert.equal(current.limits[1].liftReason, "恢复");
    const historical = await reader.read("G001");
    assert.equal(historical.records[0].body, "旧正文");
    assert.deepEqual(historical.snapshotActiveLimits, []);
    assert.equal(historical.records[0].activeLimits.length, 1);
    assert.deepEqual(await readdir(path.join(root, ".agent", "knowledge")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("warns about missing or malformed published records while showing intact siblings", async () => {
  const root = await fixture();
  try {
    await put(root, "CURRENT", "G001\n");
    await put(root, "limits.json", []);
    await put(root, "snapshots/G001.json", { id: "G001", records: [{ id: "C001", version: 1 }, { id: "E001", version: 1 }, { id: "K001", version: 1 }], activeLimits: [], proposals: [] });
    await put(root, "records/C001/v1.md", record("C001", 1, "可读正文"));
    await put(root, "records/E001/v1.md", "bad record");
    const view = await new WorkflowKnowledgeReader(root).read();
    assert.deepEqual(view.records.map(x => x.id), ["C001"]);
    assert(view.warnings.some(x => x.includes("E001@1") && x.includes("格式错误")));
    assert(view.warnings.some(x => x.includes("K001@1") && x.includes("文件缺失")));
    await rm(path.join(root, ".agent", "knowledge", "limits.json"));
    const withoutLimits = await new WorkflowKnowledgeReader(root).read();
    assert(withoutLimits.warnings.some(x => x.includes("limits.json 不存在")));
    assert.equal(withoutLimits.records[0].availability, undefined);
    assert(withoutLimits.records[0].lines.includes("本记录直接限制：不可核验"));
    assert(withoutLimits.records[0].lines.includes("当前单记录可用性：不可核验"));
    await put(root, "limits.json", [{ target: "C001", kind: "unrecognized", reason: "错误", authority: "D001", since: "2026-01-01" }]);
    const malformedLimits = await new WorkflowKnowledgeReader(root).read();
    assert(malformedLimits.warnings.some(x => x.includes("limits.json 结构错误")));
    assert.equal(malformedLimits.records[0].availability, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports missing CURRENT and missing selected snapshot without creating store", async () => {
  const root = await fixture();
  try {
    const missing = await new WorkflowKnowledgeReader(root).read();
    assert(missing.warnings.some(x => x.includes("目录不存在")));
    await put(root, "CURRENT", "G999\n");
    await put(root, "limits.json", []);
    const broken = await new WorkflowKnowledgeReader(root).read();
    assert(broken.warnings.some(x => x.includes("G999") && x.includes("不存在")));
    const historical = await new WorkflowKnowledgeReader(root).read("G001");
    assert(historical.warnings.some(x => x.includes("G001") && x.includes("不存在")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects traversal in CURRENT, snapshot ids and symlinked record targets", async () => {
  const root = await fixture(), external = await fixture();
  try {
    await put(root, "CURRENT", "../../outside\n");
    await put(root, "limits.json", []);
    const invalid = await new WorkflowKnowledgeReader(root).read();
    assert(invalid.warnings.some(x => x.includes("无效快照编号")));
    await assert.rejects(() => new WorkflowKnowledgeReader(root).read("../outside"), /无效知识快照编号/);
    await put(root, "snapshots/G001.json", { id: "G001", records: [{ id: "C001", version: 1 }], activeLimits: [], proposals: [] });
    await mkdir(path.join(root, ".agent", "knowledge", "records", "C001"), { recursive: true });
    const outside = path.join(external, "secret.md");
    await writeFile(outside, record("C001", 1, "不能读取的正文"));
    await symlink(outside, path.join(root, ".agent", "knowledge", "records", "C001", "v1.md"));
    await assert.rejects(() => new WorkflowKnowledgeReader(root).read("G001"), /路径越界/);
    assert.equal(await readFile(outside, "utf8"), record("C001", 1, "不能读取的正文"));
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});
