import "server-only";

import { schema } from "@cca/db";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { serverEnv } from "./env";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const globalForDb = globalThis as unknown as { ccaPool?: Pool; ccaDb?: Db };

function db(): Db {
  if (!globalForDb.ccaDb) {
    // One pool per process; cached on globalThis so dev hot-reloads don't leak connections.
    globalForDb.ccaPool = new Pool({ connectionString: serverEnv().DATABASE_URL, max: 10 });
    globalForDb.ccaDb = drizzle(globalForDb.ccaPool, { schema });
  }
  return globalForDb.ccaDb;
}

/**
 * Connection for identity tables (Better Auth) and the narrow SECURITY DEFINER lookups.
 * Tenant tables are invisible through it: without app.tenant_id, RLS returns no rows.
 */
export function identityDb(): Db {
  return db();
}

/**
 * The only way application code touches tenant data. Runs `fn` in a transaction whose
 * `app.tenant_id` is set, so Postgres row-level security filters every statement to that tenant.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("withTenant: tenantId must be a UUID");
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Cross-tenant access for founder admin routes. Callers must have verified the admin session
 * before calling; this function does not authenticate.
 */
export async function withAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_admin', 'on', true)`);
    return fn(tx);
  });
}

/** Close the pool (tests and graceful shutdown). */
export async function closeDb(): Promise<void> {
  await globalForDb.ccaPool?.end();
  globalForDb.ccaPool = undefined;
  globalForDb.ccaDb = undefined;
}

/** True for a Postgres unique_violation, whether raw or wrapped by the ORM. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
