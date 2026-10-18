import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createFileKnowledgeStore, parseRecordTarget } from "../../../src/knowledge/store.ts";
import type { AvailabilityReport, Limit, RecordType, Snapshot } from "../../../src/knowledge/types.ts";

const RECORD_ID = /^[CKEJQDX]\d{3,}$/;
const SNAPSHOT_ID = /^G\d{3,}$/;
const KINDS: readonly RecordType[] = ["C", "K", "E", "J", "Q", "D", "X"];

export interface KnowledgeRecordView {
  id: string;
  version: number;
  kind: RecordType;
  title: string;
  status: string;
  body: string;
  metadata: Record<string, unknown>;
  /** All stored metadata and the unabridged body, ready for a plain text viewer. */
  lines: string[];
  activeLimits: Limit[];
  availability?: AvailabilityReport;
}

export interface KnowledgeView {
  snapshotId?: string;
  snapshot?: Snapshot;
  snapshots: Array<{ id: string; createdAt?: string }>;
  records: KnowledgeRecordView[];
  /** Live limits are authoritative even while browsing an older snapshot. */
  limits: Limit[];
  /** Informational labels captured when the selected snapshot was published. */
  snapshotActiveLimits: string[];
  storeId?: string;
  warnings: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLimit(value: unknown): value is Limit {
  if (!object(value) || typeof value.target !== "string") return false;
  const target = parseRecordTarget(value.target);
  if (!target || target.version !== undefined && (!Number.isSafeInteger(target.version) || target.version < 1) ||
      !["suspended", "withdrawn", "needs_recheck"].includes(String(value.kind)) ||
      typeof value.reason !== "string" || !value.reason.trim() ||
      typeof value.authority !== "string" || !value.authority.trim() ||
      typeof value.since !== "string" || !value.since.trim()) return false;
  return (value.liftedAt === undefined || typeof value.liftedAt === "string" && !!value.liftedAt.trim()) &&
    (value.liftReason === undefined || typeof value.liftReason === "string" && !!value.liftReason.trim());
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
  return object(error) && typeof error.code === "string" ? error.code : undefined;
}

export function knowledgeStatusLabel(status: string): string {
  switch (status) {
    case "candidate": return "候选";
    case "working_assumption": return "工作假设";
    case "adopted": return "历史采用";
    case "suspended": return "暂停使用";
    case "withdrawn": return "已撤回";
    case "replaced": return "已替代";
    case "needs_recheck": return "需要复查";
    case "restricted": return "限制使用";
    default: return status || "未记录";
  }
}

function formatField(key: string, value: unknown): string[] {
  const rendered = JSON.stringify(value, null, 2);
  return [`${key}:`, ...(rendered === undefined ? ["  null"] : rendered.split("\n").map(line => `  ${line}`))];
}

function parseRecord(text: string, expectedId: string, expectedVersion: number): { metadata: Record<string, unknown>; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error(`知识记录 ${expectedId}@${expectedVersion} 缺少前置信息`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`知识记录 ${expectedId}@${expectedVersion} 前置信息未闭合`);
  const metadata: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`知识记录 ${expectedId}@${expectedVersion} 前置信息格式错误`);
    const key = line.slice(0, colon);
    if (Object.hasOwn(metadata, key)) throw new Error(`知识记录 ${expectedId}@${expectedVersion} 重复字段 ${key}`);
    try { metadata[key] = JSON.parse(line.slice(colon + 1).trim()) as unknown; }
    catch { throw new Error(`知识记录 ${expectedId}@${expectedVersion} 字段 ${key} 无法解析`); }
  }
  if (metadata.id !== expectedId || metadata.version !== expectedVersion || !KINDS.includes(metadata.type as RecordType) || metadata.type !== expectedId[0] || typeof metadata.title !== "string") {
    throw new Error(`知识记录 ${expectedId}@${expectedVersion} 身份字段与快照不符`);
  }
  return { metadata, body: lines.slice(end + 1).join("\n") };
}

/** Reads only published C/K/E/J/Q/D/X knowledge. Never initializes or writes the store. */
export class WorkflowKnowledgeReader {
  readonly workspace: string;
  constructor(workspace: string) { this.workspace = path.resolve(workspace); }

  private async confined(root: string, file: string): Promise<string> {
    const resolved = await realpath(file);
    if (!inside(root, resolved)) throw new Error(`知识库路径越界：${file}`);
    if (!(await stat(resolved)).isFile()) throw new Error(`知识库路径不是文件：${file}`);
    return resolved;
  }

  private async text(root: string, file: string): Promise<string> {
    return readFile(await this.confined(root, file), "utf8");
  }

  private async json(root: string, file: string): Promise<unknown> {
    const source = await this.text(root, file);
    try { return JSON.parse(source) as unknown; }
    catch { throw new Error(`知识库 JSON 无法解析：${file}`); }
  }

  async read(snapshotId?: string): Promise<KnowledgeView> {
    const warnings: string[] = [];
    const empty = (): KnowledgeView => ({ snapshots: [], records: [], limits: [], snapshotActiveLimits: [], warnings });
    const workspace = await realpath(this.workspace);
    const dir = path.join(workspace, ".agent", "knowledge");
    let knowledge: string;
    try { knowledge = await realpath(dir); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      warnings.push("知识库目录不存在");
      return empty();
    }
    if (!inside(workspace, knowledge)) throw new Error(`知识库目录越过工作区：${dir}`);
    if (!(await stat(knowledge)).isDirectory()) throw new Error(`知识库路径不是目录：${dir}`);
    if (snapshotId !== undefined && !SNAPSHOT_ID.test(snapshotId)) throw new Error(`无效知识快照编号：${snapshotId}`);

    const view = empty();
    const snapshotsDir = path.join(knowledge, "snapshots");
    let names: string[] = [];
    try {
      const resolvedSnapshots = await realpath(snapshotsDir);
      if (!inside(knowledge, resolvedSnapshots)) throw new Error(`知识快照目录越界：${snapshotsDir}`);
      if (!(await stat(resolvedSnapshots)).isDirectory()) throw new Error(`知识快照路径不是目录：${snapshotsDir}`);
      names = await readdir(resolvedSnapshots);
    }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      warnings.push("知识快照目录不存在");
    }
    for (const name of names.filter(name => SNAPSHOT_ID.test(name.slice(0, -5)) && name.endsWith(".json")).sort()) {
      const id = name.slice(0, -5);
      const data = await this.json(knowledge, path.join(snapshotsDir, name));
      if (!object(data) || data.id !== id || !Array.isArray(data.records)) throw new Error(`知识快照结构错误：${id}`);
      view.snapshots.push({ id, createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined });
    }

    let current: string | undefined;
    try { current = (await this.text(knowledge, path.join(knowledge, "CURRENT"))).trim(); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      warnings.push("知识库 CURRENT 不存在");
    }
    if (current && !SNAPSHOT_ID.test(current)) {
      warnings.push(`CURRENT 含无效快照编号：${current}`);
      current = undefined;
    }
    if (!current) warnings.push("知识库尚无 CURRENT 已发布快照");
    const selected = snapshotId ?? current;
    view.snapshotId = selected;

    try {
      const identity = await this.json(knowledge, path.join(knowledge, "store-id.json"));
      if (object(identity) && typeof identity.storeId === "string") view.storeId = identity.storeId;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      warnings.push("知识库 store-id.json 不存在");
    }
    let liveLimitsVerified = false;
    try {
      const limitsFile = path.join(knowledge, "limits.json");
      const source = await this.text(knowledge, limitsFile);
      let limits: unknown;
      try { limits = JSON.parse(source) as unknown; }
      catch { warnings.push("知识库 limits.json 无法解析，实时可用性不可核验"); }
      if (limits !== undefined) {
        if (!Array.isArray(limits) || !limits.every(validLimit)) warnings.push("知识库 limits.json 结构错误，实时可用性不可核验");
        else { view.limits = limits; liveLimitsVerified = true; }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      warnings.push("知识库 limits.json 不存在，实时可用性不可核验");
    }
    if (!selected) return view;
    if (!view.snapshots.some(item => item.id === selected)) {
      warnings.push(`${snapshotId ? "所选历史快照" : "CURRENT 指向的快照"} ${selected} 不存在`);
      return view;
    }
    const raw = await this.json(knowledge, path.join(snapshotsDir, `${selected}.json`));
    const snapshot = raw as Snapshot;
    if (!object(raw) || raw.id !== selected || !Array.isArray(raw.records) || !Array.isArray(raw.activeLimits)) throw new Error(`知识快照结构错误：${selected}`);
    view.snapshot = snapshot;
    view.snapshotActiveLimits = snapshot.activeLimits;
    const store = createFileKnowledgeStore(knowledge);
    let liveVersions: Map<string, number> | undefined;
    if (current) {
      try {
        const live = await this.json(knowledge, path.join(snapshotsDir, `${current}.json`));
        if (!object(live) || live.id !== current || !Array.isArray(live.records) ||
            !live.records.every(ref => object(ref) && typeof ref.id === "string" && RECORD_ID.test(ref.id) &&
              typeof ref.version === "number" && Number.isSafeInteger(ref.version) && ref.version > 0)) throw new Error("CURRENT 快照结构不可用于实时可用性核验");
        const refs = live.records as Array<{ id: string; version: number }>;
        liveVersions = new Map(refs.map(ref => [ref.id, ref.version]));
        if (liveVersions.size !== live.records.length) throw new Error("CURRENT 快照存在重复记录引用");
      } catch (error) { warnings.push(`实时知识快照不可核验：${error instanceof Error ? error.message : String(error)}`); }
    }
    const seen = new Set<string>();
    for (const ref of snapshot.records) {
      if (!object(ref) || typeof ref.id !== "string" || !RECORD_ID.test(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1 || seen.has(ref.id)) throw new Error(`知识快照 ${selected} 含无效或重复记录引用`);
      seen.add(ref.id);
      const recordFile = path.join(knowledge, "records", ref.id, `v${ref.version}.md`);
      let source: string;
      try { source = await this.text(knowledge, recordFile); }
      catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        warnings.push(`快照 ${selected} 引用的知识记录 ${ref.id}@${ref.version} 文件缺失`);
        continue;
      }
      let parsed: ReturnType<typeof parseRecord>;
      try { parsed = parseRecord(source, ref.id, ref.version); }
      catch (error) {
        warnings.push(`快照 ${selected} 引用的知识记录 ${ref.id}@${ref.version} 格式错误：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const { metadata, body } = parsed;
      const activeLimits = view.limits.filter(limit => !limit.liftedAt && (limit.target === ref.id || limit.target === `${ref.id}@${ref.version}`));
      const status = typeof metadata.usageDecision === "string" ? metadata.usageDecision : "未记录";
      let availability: AvailabilityReport | undefined;
      if (liveVersions && liveLimitsVerified) try {
        const publishedVersion = liveVersions.get(ref.id);
        if (publishedVersion !== undefined) {
          // availability() may inspect prior decisions. Confine each published
          // version before letting the shared read-only store inspect history.
          const recordDir = path.join(knowledge, "records", ref.id);
          const realRecordDir = await realpath(recordDir);
          if (!inside(knowledge, realRecordDir) || !(await stat(realRecordDir)).isDirectory())
            throw new Error("已发布记录目录越界或不是目录");
          const names = (await readdir(recordDir)).filter(name => /^v[1-9]\d*\.md$/u.test(name) &&
            Number(name.slice(1, -3)) <= publishedVersion);
          if (names.length !== publishedVersion) throw new Error("已发布历史版本不完整");
          for (let version = 1; version <= publishedVersion; version++) {
            if (!names.includes(`v${version}.md`)) throw new Error("已发布历史版本不连续");
            await this.confined(knowledge, path.join(recordDir, `v${version}.md`));
          }
        }
        availability = await store.availability(ref.id, ref.version);
      } catch (error) { warnings.push(`${ref.id}@${ref.version} 实时可用性不可核验：${error instanceof Error ? error.message : String(error)}`); }
      const lines = [
        `${ref.id}@${ref.version} ${String(metadata.title)}`,
        `历史使用决定：${knowledgeStatusLabel(status)}（${status}）`,
        `依据状况：${typeof metadata.evidenceStatus === "string" ? metadata.evidenceStatus : "未记录"}`,
        `本记录直接限制：${!liveLimitsVerified ? "不可核验" : activeLimits.length ? `${activeLimits.length} 条；${activeLimits.map(l => `${l.target} ${knowledgeStatusLabel(l.kind)}`).join("、")}（完整理由见正文后的限制明细）` : "无"}`,
        `当前单记录可用性：${availability?.availability ?? "不可核验"}${availability?.reasons.length ? `；${availability.reasons.join("；")}` : ""}`,
        "必要依赖闭包与反证适用性须通过知识选择/读取入口核对；单记录可用性不证明整组可应用。",
        "",
        "正文：",
        ...body.split("\n"),
        "",
        ...(activeLimits.length ? ["限制明细：", ...activeLimits.flatMap((limit, index) => [`${index + 1}. ${limit.target} · ${knowledgeStatusLabel(limit.kind)}`, `原因：${limit.reason}`, `依据：${limit.authority}`, `生效于：${limit.since}`, ""])] : []),
        "完整记录元数据：",
        ...Object.entries(metadata).flatMap(([key, value]) => formatField(key, value)),
      ];
      view.records.push({ id: ref.id, version: ref.version, kind: metadata.type as RecordType, title: metadata.title as string, status, body, metadata, lines, activeLimits,
        ...(availability ? { availability } : {}) });
    }
    return view;
  }
}
