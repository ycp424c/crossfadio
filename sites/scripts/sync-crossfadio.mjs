import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sitesDir = path.resolve(scriptDir, "..");
const sourceDir = path.resolve(sitesDir, "..", "dist");
const targetDir = path.resolve(sitesDir, "public", "crossfadio");

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
