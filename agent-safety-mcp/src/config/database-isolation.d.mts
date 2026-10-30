export interface TestDatabaseIdentity {
  kind: "supabase" | "local";
  projectRef?: string;
  host?: string;
  port?: number;
  database: string;
}

export function assertIsolatedTestDatabaseConfig(env: NodeJS.ProcessEnv): TestDatabaseIdentity;
export function verifyConnectedTestDatabase(
  queryable: { query(sql: string): Promise<{ rows: Array<{ database_name?: string }> }> },
  identity: TestDatabaseIdentity | undefined
): Promise<void>;
export function isIsolatedTestActionEnvironment(env: NodeJS.ProcessEnv): boolean;
