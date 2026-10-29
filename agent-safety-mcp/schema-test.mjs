import { Pool } from 'pg';
import dotenv from 'dotenv';

if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual database diagnostic');
dotenv.config();

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is not accepted');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const testSchema = async () => {
  let client;
  try {
    client = await pool.connect();
    
    console.log('=== SCHEMA VERIFICATION ===\n');
    
    // Check each critical table
    const tables = {
      actions: ['id', 'agent_id', 'idempotency_key', 'status', 'episode_id', 'lease_owner', 'attempts'],
      episodes: ['episode_id', 'narrative', 'outcome', 'status'],
      agents: ['id', 'key', 'name', 'metadata'],
      conflicts: ['id', 'first_intent_id', 'second_intent_id'],
      intents: ['id', 'agent_id', 'narrative'],
      test_external_effects: ['id', 'action_id', 'idempotency_key', 'verifier_response']
    };
    
    for (const [tableName, requiredCols] of Object.entries(tables)) {
      const result = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = '${tableName}'
      `);
      
      const actualCols = result.rows.map(r => r.column_name);
      const missing = requiredCols.filter(col => !actualCols.includes(col));
      
      if (missing.length === 0) {
        console.log(`✅ ${tableName}: All required columns present`);
      } else {
        console.log(`⚠️  ${tableName}: Missing columns: ${missing.join(', ')}`);
      }
    }
    
    // Check indexes
    console.log('\n=== INDEXES ===\n');
    const indexes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY indexname
    `);
    
    console.log(`Total indexes: ${indexes.rows.length}`);
    indexes.rows.forEach(idx => console.log(`  • ${idx.indexname}`));
    
    // Test idempotency constraint
    console.log('\n=== CONSTRAINT CHECK ===\n');
    const constraints = await client.query(`
      SELECT constraint_name, table_name 
      FROM information_schema.table_constraints 
      WHERE constraint_type = 'UNIQUE' AND table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log(`UNIQUE constraints: ${constraints.rows.length}`);
    constraints.rows.forEach(c => console.log(`  • ${c.table_name}.${c.constraint_name}`));
    
  } finally {
    if (client) client.release();
    await pool.end();
    process.exit(0);
  }
};

testSchema();
