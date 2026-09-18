// Create the local databases and the cca_app login role. Local development only.
//
// Reads DATABASE_URL (app role) and DATABASE_MIGRATION_URL (owner) from ../.env.
// Refuses to touch anything that is not localhost.
import pg from "pg";

const appUrl = new URL(required("DATABASE_URL"));
const ownerUrl = new URL(required("DATABASE_MIGRATION_URL"));
const testDb = new URL(process.env.TEST_DATABASE_URL ?? appUrl.href).pathname.slice(1);

for (const u of [appUrl, ownerUrl]) {
  if (!["localhost", "127.0.0.1"].includes(u.hostname)) {
    fail(`setup-local only runs against localhost, got ${u.hostname}`);
  }
}
if (appUrl.username !== "cca_app") fail("DATABASE_URL must connect as cca_app");

const adminUrl = new URL(ownerUrl.href);
adminUrl.pathname = "/postgres";
const client = new pg.Client({ connectionString: adminUrl.href });
await client.connect();
try {
  const password = decodeURIComponent(appUrl.password);
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'cca_app'");
  const verb = rowCount ? "ALTER" : "CREATE";
  // Identifiers and literals cannot be bound parameters in DDL; quote via the server.
  const { rows } = await client.query("SELECT quote_literal($1) AS pw", [password]);
  await client.query(
    `${verb} ROLE cca_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${rows[0].pw}`,
  );
  console.log(`${verb === "CREATE" ? "created" : "updated"} role cca_app`);

  for (const db of new Set([appUrl.pathname.slice(1), testDb])) {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
    if (exists.rowCount) {
      console.log(`database ${db} already exists`);
    } else {
      const { rows: q } = await client.query("SELECT quote_ident($1) AS db", [db]);
      await client.query(`CREATE DATABASE ${q[0].db}`);
      console.log(`created database ${db}`);
    }
  }
} finally {
  await client.end();
}

function required(name) {
  const v = process.env[name];
  if (!v) fail(`${name} is not set (copy .env.example to .env)`);
  return v;
}

function fail(msg) {
  console.error(`setup-local: ${msg}`);
  process.exit(1);
}
