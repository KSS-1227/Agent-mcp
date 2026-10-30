import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ActionCoordinator } from './dist/recovery-engine/coordinator.js';
import { assertIsolatedTestDatabaseConfig, verifyConnectedTestDatabase } from './src/config/database-isolation.mjs';
import dotenv from 'dotenv';

dotenv.config();
if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual database test');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is not accepted');
const testIdentity = assertIsolatedTestDatabaseConfig(process.env);

const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const coordinatorId = '550e8400-e29b-41d4-a716-446655440000';
const episodeId = `quick-test:${randomUUID()}`;

async function test() {
  let identityVerified = false;
  try {
    await verifyConnectedTestDatabase(db, testIdentity);
    identityVerified = true;
    const coordinator = new ActionCoordinator(db, coordinatorId, 120);

    await db.query(
      `INSERT INTO episodes (episode_id, narrative, outcome, status)
       VALUES ($1, $2, 'test', 'pending')`,
      [episodeId, `Quick test ${episodeId}`]
    );

    const result = await coordinator.intend(episodeId, 'test-action', { param: 'value' });
    console.log('Intend result:', result.disposition, 'Expected: 0');

    if (result.disposition === 0) {
      const updateResult = await coordinator.updateEffectState(result.action.idemKey, 'IN_PROGRESS', 'NOT_STARTED');
      console.log('updateEffectState result:', updateResult, 'Expected: true');
      if (!updateResult) process.exitCode = 1;
    } else {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    try {
      if (identityVerified) {
        const client = await db.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          await verifyConnectedTestDatabase(client, testIdentity);
          await client.query(
            `DELETE FROM actions
              WHERE episode_id = $1 AND agent_id = $2 AND action_type = $3`,
            [episodeId, coordinatorId, 'test-action']
          );
          await client.query(
            `DELETE FROM episodes
              WHERE episode_id = $1 AND narrative = $2 AND outcome = 'test'`,
            [episodeId, `Quick test ${episodeId}`]
          );
          await client.query('COMMIT');
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch { /* connection may already be aborted */ }
          throw error;
        } finally {
          client.release();
        }
      }
    } catch (error) {
      console.error('Test cleanup failed; isolated test fixture may remain:', error instanceof Error ? error.message : 'unknown error');
      process.exitCode = 1;
    } finally {
      await db.end();
    }
  }
}

await test();
