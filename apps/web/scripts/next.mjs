// Run the Next.js CLI with the repo-root .env loaded, so the web app, worker and db scripts share
// one local env file. Variables already set (e.g. by the hosting platform) are never overridden.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Playwright starts the server with this flag so end-to-end runs never write into the dev database.
if (process.env.E2E_USE_TEST_DATABASE === "1") {
  if (!process.env.TEST_DATABASE_URL) throw new Error("E2E_USE_TEST_DATABASE=1 needs TEST_DATABASE_URL");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
