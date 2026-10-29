import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new Pool();

async function migrate() {
  const client = await pool.connect();
  try {
    const migFile = 'supabase/migrations/20240101000015_phase_10f_effect_state.sql';
    const sql = fs.readFileSync(migFile, 'utf8');
    
    console.log('Executing migration: 20240101000015_phase_10f_effect_state');
    const result = await client.query(sql);
    console.log('Success');
    
    // Verify columns exist
    const verify = await client.query(`
      SELECT COUNT(*) as cnt FROM information_schema.columns 
      WHERE table_name='actions' AND column_name IN (
        'effect_state', 'effect_started_at', 'effect_completed_at', 
        'verifier_response', 'verified_at'
      )
    `);
    console.log('Columns verified: ' + verify.rows[0].cnt);
  } catch (e) {
    console.log('Error: ' + e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();