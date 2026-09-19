import { rmSync } from "node:fs";
import path from "node:path";

import pg from "pg";

/** Every e2e run starts from an empty test database, inbox and storage directory. */
export default async function globalSetup(): Promise<void> {
  const root = path.resolve(__dirname, "../../..");
  process.loadEnvFile(path.join(root, ".env"));
  const url = process.env.TEST_DATABASE_MIGRATION_URL;
  if (!url || !/\/cca_test$/.test(new URL(url).pathname)) {
    throw new Error("e2e reset refused: TEST_DATABASE_MIGRATION_URL must point at cca_test");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('TRUNCATE tenant, audit_event, "user", verification CASCADE');
  } finally {
    await client.end();
  }
  for (const dir of ["test-results/e2e-inbox", "test-results/e2e-storage"]) {
    rmSync(path.resolve(__dirname, "..", dir), { recursive: true, force: true });
  }
}
