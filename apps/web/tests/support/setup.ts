import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env, then point the app at the test database.
const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_DATABASE_MIGRATION_URL) {
  throw new Error("TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL must be set (see .env.example)");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-00";

// Storage and email in throwaway directories; no worker kicks unless a test opts in.
process.env.APP_ENV = "test";
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "cca-storage-"));
process.env.EMAIL_DRIVER = "dev-inbox";
process.env.DEV_INBOX_DIR = mkdtempSync(path.join(tmpdir(), "cca-inbox-"));
process.env.ADMIN_EMAILS = "founder@admin.test";
delete process.env.WORKER_URL;
