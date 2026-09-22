import path from "node:path";

export const TEXT_EXTENSIONS = new Set([
".txt", ".md", ".markdown",
".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".toml",
".xml", ".html", ".htm",
".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
".py", ".rs", ".go", ".java",
".c", ".cc", ".cpp", ".h", ".hpp",
".sh", ".zsh", ".fish", ".sql", ".tex",
]);

export function isTextFile(file: string): boolean {
return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function mediaType(file: string): "text" | "binary" {
return isTextFile(file) ? "text" : "binary";
}
