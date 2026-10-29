const { Pool } = require('pg');
if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual database diagnostic');
require('dotenv').config();

const DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is not accepted');

const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ Pool error:', err.message);
});

const testConnection = async () => {
  let client;
  try {
    console.log('⏳ Attempting connection...');
    client = await Promise.race([
      pool.connect(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 8000)
      )
    ]);
    
    console.log('✅ Connected to PostgreSQL!');
    
    // Test query
    const result = await client.query('SELECT now()');
    console.log('✅ Test query successful');
    console.log('   Current time:', result.rows[0].now);
    
    // Check tables
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('✅ Found', tables.rows.length, 'tables');
    console.log('');
    console.log('Tables:');
    tables.rows.forEach((row, i) => {
      console.log(`  ${i+1}. ${row.table_name}`);
    });
    
  } catch (err) {
    console.log('❌ Connection failed');
    console.log('   Error:', err.message);
    console.log('   Code:', err.code);
  } finally {
    if (client) client.release();
    await pool.end();
    process.exit(0);
  }
};

testConnection();
