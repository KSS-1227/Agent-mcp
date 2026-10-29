import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'supabase/migrations');

async function loadMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && f !== '.gitkeep')
    .sort();

  return files.map(filename => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf-8');
    return { filename, content };
  });
}

async function runMigrations(supabaseUrl, serviceKey) {
  console.log('?? Starting migrations against Supabase...\n');

  const migrations = await loadMigrations();
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let success = 0, failed = 0;

  for (const m of migrations) {
    console.log(? \);
    try {
      const statements = m.content.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--'));
      for (const stmt of statements) {
        const { error } = await supabase.rpc('exec_sql', { sql_text: stmt });
        if (error) throw new Error(error.message);
      }
      console.log(   ?\n);
      success++;
    } catch (e) {
      console.log(   ? \\n);
      failed++;
    }
  }

  console.log(? \ succeeded, ? \ failed);
  process.exit(failed > 0 ? 1 : 0);
}

if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual migration utility');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required as the migration diagnostic opt-in');
const url = process.env.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY are required');

runMigrations(url, key);
