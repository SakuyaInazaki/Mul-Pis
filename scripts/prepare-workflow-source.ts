/** CLI wrapper for the source preparation implementation included in snapshots. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWorkflowCodeSource } from "../src/runtime/prepare-source.ts";

export { prepareWorkflowCodeSource } from "../src/runtime/prepare-source.ts";
export type { WorkflowCodeSnapshot } from "../src/runtime/prepare-source.ts";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const [repository, revision, outputRoot, ...extra] = process.argv.slice(2);
 if (!repository || !revision || !outputRoot || extra.length) throw new Error("Usage: node scripts/prepare-workflow-source.ts <repository> <full-commit> <new-source-directory>");
 console.log(JSON.stringify(await prepareWorkflowCodeSource(repository, revision, outputRoot), null, 2));
}
