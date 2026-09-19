// Apply committed migrations as the schema owner.
//   npm run db:migrate            -> DATABASE_MIGRATION_URL
//   npm run db:migrate -- --test  -> TEST_DATABASE_MIGRATION_URL
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const useTest = process.argv.includes("--test");
const envName = useTest ? "TEST_DATABASE_MIGRATION_URL" : "DATABASE_MIGRATION_URL";
const url = process.env[envName];
if (!url) {
  console.error(`migrate: ${envName} is not set`);
  process.exit(1);
}

// Hosted databases require TLS. (Supabase's CA is not in Node's default store; the connection is
// encrypted, and the certificate chain is not pinned yet — see docs/deployment.md.)
const host = new URL(url).hostname;
const local = host === "localhost" || host === "127.0.0.1";
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: local ? undefined : { rejectUnauthorized: false } });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  console.log(`migrations applied (${new URL(url).pathname.slice(1)} on ${local ? "localhost" : host})`);
} finally {
  await pool.end();
}
