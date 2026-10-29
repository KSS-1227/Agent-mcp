/**
 * Database Client - PostgreSQL/Supabase connection
 * Unified client for both Anchor and Interlock
 */

import { Pool, Client, QueryResult, QueryResultRow, PoolClient } from "pg";

export interface DatabaseConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

/**
 * Create a PostgreSQL connection pool.
 */
export function createPool(config: DatabaseConfig): Pool {
  return new Pool(config);
}

/**
 * Transaction helper type
 */
export interface Transaction {
  query<R extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<R>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  client?: PoolClient;
}

/**
 * PostgreSQL-based transaction implementation
 */
class PostgresTransaction implements Transaction {
  client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async query<R extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<R>> {
    return this.client.query<R>(text, values);
  }

  async commit(): Promise<void> {
    await this.client.query("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.client.query("ROLLBACK");
  }
}

/**
 * Begin a SERIALIZABLE transaction for exactly-once guarantees
 */
export async function beginTransaction(pool: Pool): Promise<Transaction> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    return new PostgresTransaction(client);
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Connection pool wrapper with helper methods
 */
export class DatabaseClient {
  constructor(private pool: Pool) {}

  async query<R extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  async transaction<T>(
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PostgresTransaction(client);
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors if transaction already failed
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabaseClient(config: DatabaseConfig): DatabaseClient {
  const pool = createPool(config);
  return new DatabaseClient(pool);
}
