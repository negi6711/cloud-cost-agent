import pg from "pg";

/**
 * A connection as the schema owner (bypasses RLS). Used only by tests to set up and inspect state
 * that the application role is not allowed to see.
 */
export async function withOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_MIGRATION_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function resetTenants(): Promise<void> {
  await withOwner((c) => c.query('TRUNCATE tenant, audit_event, "user", verification CASCADE'));
}
