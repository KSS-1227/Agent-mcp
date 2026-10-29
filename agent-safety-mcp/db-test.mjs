import { Pool } from 'pg';
import dotenv from 'dotenv';

if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual database diagnostic');
dotenv.config();

const DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is not accepted');

console.log('=== PostgreSQL Connection Test ===\n');
console.log('Connection string (masked):');
console.log('  postgresql://postgres:****@db.qrybckrzzzfhgqthxnpu.supabase.co:5432/postgres\n');

const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false }
});

const testConnection = async () => {
  let client;
  try {
    console.log('⏳ Connecting to PostgreSQL...');
    client = await pool.connect();
    
    console.log('✅ SUCCESS - Connected to PostgreSQL!\n');
    
    // Test query
    const result = await client.query('SELECT now() as current_time, version() as pg_version');
    const row = result.rows[0];
    console.log('Database Information:');
    console.log(`  Current time: ${row.current_time}`);
    console.log(`  Version: ${row.pg_version.split(',')[0]}\n`);
    
    // List tables
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    console.log(`Tables (${tables.rows.length} total):`);
    tables.rows.forEach((row) => {
      console.log(`  • ${row.table_name}`);
    });
    
    console.log('\n✅ All checks passed - Direct PostgreSQL connection is WORKING');
    
  } catch (err) {
    console.log('❌ Connection FAILED\n');
    console.log(`Error: ${err.message}`);
    console.log(`Code: ${err.code || 'UNKNOWN'}\n`);
    
    if (err.code === 'ENOTFOUND') {
      console.log('💡 Issue: DNS lookup failed');
      console.log('   Possible causes:');
      console.log('   - Network connectivity issue');
      console.log('   - Hostname is incorrect');
      console.log('   - Firewall blocking DNS queries');
    } else if (err.code === 'ECONNREFUSED') {
      console.log('💡 Issue: Connection refused');
      console.log('   Possible causes:');
      console.log('   - PostgreSQL server not running');
      console.log('   - Port 5432 closed or blocked');
      console.log('   - Firewall blocking the connection');
    } else if (err.code === 'ETIMEDOUT') {
      console.log('💡 Issue: Connection timeout');
      console.log('   Possible causes:');
      console.log('   - Server is slow to respond');
      console.log('   - Network latency is high');
      console.log('   - Firewall is rate-limiting');
    }
  } finally {
    if (client) client.release();
    await pool.end();
    process.exit(0);
  }
};

testConnection();
