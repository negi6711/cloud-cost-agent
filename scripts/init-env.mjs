// Create .env from .env.example, replacing secret placeholders with random local values.
// Never overwrites an existing .env unless --force is passed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const force = process.argv.includes("--force");
if (existsSync(".env") && !force) {
  console.log(".env already exists (use --force to regenerate)");
  process.exit(0);
}
const out = readFileSync(".env.example", "utf8")
  .replaceAll("replace-with-32+-random-bytes", () => randomBytes(32).toString("base64url"))
  // The web app and the worker run from different directories; an absolute path removes ambiguity.
  .replace(/^LOCAL_STORAGE_DIR=.*$/m, `LOCAL_STORAGE_DIR=${resolve(".local-storage").replaceAll("\\", "/")}`);
writeFileSync(".env", out);
console.log("wrote .env with fresh local secrets");
