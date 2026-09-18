import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load the repo-root .env, then point the app at the test database.
const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_DATABASE_MIGRATION_URL) {
  throw new Error("TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL must be set (see .env.example)");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-00";
