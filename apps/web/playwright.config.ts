import { mkdirSync } from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 8201);
const REPO_ROOT = path.resolve(__dirname, "../..");

// Web app and worker share one throwaway storage directory and the test database, so e2e runs
// never touch cca_dev or .local-storage.
const STORAGE_DIR = path.resolve(__dirname, "test-results/e2e-storage");
const INBOX_DIR = path.resolve(__dirname, "test-results/e2e-inbox");
// Created here and again by the servers on demand; global setup empties them before each run.
mkdirSync(STORAGE_DIR, { recursive: true });
mkdirSync(INBOX_DIR, { recursive: true });

const shared = {
  ...process.env,
  APP_ENV: "test",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: STORAGE_DIR.replaceAll("\\", "/"),
} as Record<string, string>;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "test-results/artifacts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: `node scripts/next.mjs start -p ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...shared,
        E2E_USE_TEST_DATABASE: "1",
        WORKER_URL: `http://localhost:${WORKER_PORT}`,
        APP_BASE_URL: `http://localhost:${PORT}`,
        EMAIL_DRIVER: "dev-inbox",
        DEV_INBOX_DIR: INBOX_DIR.replaceAll("\\", "/"),
        ADMIN_EMAILS: "founder@admin.test",
      },
    },
    {
      command: "uv run python -m cca",
      cwd: REPO_ROOT,
      url: `http://localhost:${WORKER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...shared,
        PORT: String(WORKER_PORT),
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? readTestDatabaseUrl(),
        WORKER_ID: "worker-e2e",
        WORKER_POLL_INTERVAL_SECONDS: "1",
        // The deterministic stand-in, clearly labelled in the UI; never allowed when hosted.
        JEV_ENABLED: "true",
        JEV_PROVIDER: "mock",
      },
    },
  ],
});

/** TEST_DATABASE_URL from the repo-root .env when it is not already in the environment. */
function readTestDatabaseUrl(): string {
  const envFile = path.join(REPO_ROOT, ".env");
  process.loadEnvFile(envFile);
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for e2e runs");
  return url;
}
