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

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  console.log(`migrations applied (${new URL(url).pathname.slice(1)})`);
} finally {
  await pool.end();
}
