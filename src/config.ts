import { readFile } from "node:fs/promises";
import { HarnessError, ROLES, THINKING_LEVELS, type HarnessConfig, type ModelSpec, type Role, type ThinkingLevel } from "./types.ts";

export const CONFIG_FILE = "research.config.json";

/** Parse `provider/model` or `provider/model:thinking`. */
export function parseModelSpec(raw: string): ModelSpec {
	const value = raw.trim();
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new HarnessError("config.model", `模型写法必须是 provider/model 或 provider/model:thinking，收到：${raw}`);
	}
	const provider = value.slice(0, slash);
	const rest = value.slice(slash + 1);
	const colon = rest.lastIndexOf(":");
	if (colon > 0) {
		const level = rest.slice(colon + 1);
		if ((THINKING_LEVELS as readonly string[]).includes(level)) {
			return { provider, modelId: rest.slice(0, colon), thinkingLevel: level as ThinkingLevel, raw: value };
		}
	}
	return { provider, modelId: rest, raw: value };
}

export function validateConfig(input: unknown): HarnessConfig {
	if (!input || typeof input !== "object") {
		throw new HarnessError("config.shape", `${CONFIG_FILE} 必须是一个 JSON 对象`);
	}
	const obj = input as Record<string, unknown>;
	const rolesRaw = obj.roles;
	if (!rolesRaw || typeof rolesRaw !== "object") {
		throw new HarnessError("config.roles", `${CONFIG_FILE} 缺少 roles 对象；角色与模型由用户指定，harness 不预设模型`);
	}
	const roles: HarnessConfig["roles"] = {};
	for (const [key, value] of Object.entries(rolesRaw as Record<string, unknown>)) {
		if (key !== "default" && !(ROLES as readonly string[]).includes(key)) {
			throw new HarnessError("config.roles", `未知角色 ${key}；可用角色：${ROLES.join(", ")} 或 default`);
		}
		if (typeof value !== "string") {
			throw new HarnessError("config.roles", `角色 ${key} 的模型必须是字符串`);
		}
		parseModelSpec(value);
		roles[key as Role | "default"] = value;
	}
	const tools: HarnessConfig["tools"] = {};
	if (obj.tools !== undefined) {
		if (!obj.tools || typeof obj.tools !== "object") throw new HarnessError("config.tools", "tools 必须是对象");
		for (const [key, value] of Object.entries(obj.tools as Record<string, unknown>)) {
			if (!["braveApiKey", "searchProviders", "openAlexMailto", "browserUseModel", "pythonVenv", "pageImageDpi"].includes(key)) throw new HarnessError("config.tools", `未知 tools 字段 ${key}`);
			if (key === "searchProviders") {
				if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim())) throw new HarnessError("config.tools", "tools.searchProviders 必须是字符串数组");
				tools.searchProviders = value as string[];
				continue;
			}
			if (key === "pageImageDpi") {
				if (typeof value !== "number" || !Number.isInteger(value) || value < 50 || value > 300) throw new HarnessError("config.tools", "tools.pageImageDpi 必须是 50–300 的整数");
				tools.pageImageDpi = value;
				continue;
			}
			if (typeof value !== "string" || !value.trim()) throw new HarnessError("config.tools", `tools.${key} 必须是非空字符串`);
			(tools as Record<string, string>)[key] = value;
		}
		if (tools.browserUseModel) parseModelSpec(tools.browserUseModel);
	}
	let concurrency = 1;
	if (obj.concurrency !== undefined) {
		if (typeof obj.concurrency !== "number" || !Number.isInteger(obj.concurrency) || obj.concurrency < 1) {
			throw new HarnessError("config.concurrency", "concurrency 必须是正整数");
		}
		concurrency = obj.concurrency;
	}
	return { roles, concurrency, tools };
}

export async function loadConfig(path: string): Promise<HarnessConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new HarnessError("config.missing", `找不到 ${path}。请先创建它并为所需角色指定模型，例如 {"roles": {"execution": "provider/model:high"}}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new HarnessError("config.json", `${path} 不是合法 JSON：${(error as Error).message}`);
	}
	return validateConfig(parsed);
}

/** Resolve the model string for a role. `default` is honoured only because the user wrote it. */
export function resolveRoleModel(config: HarnessConfig, role: Role): string {
	const direct = config.roles[role];
	if (direct) return direct;
	const fallback = config.roles.default;
	if (fallback) return fallback;
	throw new HarnessError(
		"config.role-unset",
		`角色 ${role} 没有配置模型，也没有 default。请在 ${CONFIG_FILE} 的 roles 中指定；harness 不会替你选择模型`,
	);
}
