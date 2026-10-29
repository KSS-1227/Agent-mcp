import { Pool } from 'pg';
import { ActionCoordinator } from './dist/recovery-engine/coordinator.js';

if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual database test');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is not accepted');

const db = new Pool({
  connectionString: process.env.TEST_DATABASE_URL
});

const coordinator = new ActionCoordinator(db, '550e8400-e29b-41d4-a716-446655440000', 120);

async function test() {
  try {
    // Create test episode
    await db.query(`INSERT INTO episodes (episode_id, narrative, outcome, status) VALUES ('quick-test', 'Quick test', 'test', 'pending') ON CONFLICT DO NOTHING`);
    
    // Test intend
    const result = await coordinator.intend('quick-test', 'test-action', { param: 'value' });
    console.log('Intend result:', result.disposition, 'Expected: 0');
    
    if (result.disposition === 0) {
      const idemKey = result.action.idemKey;
      
      // Test updateEffectState
      const updateResult = await coordinator.updateEffectState(idemKey, 'IN_PROGRESS', 'NOT_STARTED');
      console.log('updateEffectState result:', updateResult, 'Expected: true');
    }
    
    await db.end();
    process.exit(result.disposition === 0 ? 0 : 1);
  } catch (e) {
    console.error('Error:', e.message);
    await db.end();
    process.exit(1);
  }
}

test();
