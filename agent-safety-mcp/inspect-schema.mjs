/**
 * Schema Inspector - Checks actual column names in Supabase
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual Supabase diagnostic');
dotenv.config();

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required as the diagnostic database opt-in');
const url = process.env.TEST_SUPABASE_URL;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Missing credentials");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function inspectTables() {
  console.log("📋 Inspecting Supabase schema...\n");

  const tables = ["agents", "tasks", "resources", "intents", "actions", "episodes", "managed_clusters", "intent_reads"];

  for (const table of tables) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .limit(1);

    if (error) {
      console.log(`❌ ${table}: ${error.message}`);
    } else {
      const columns = data && data.length > 0 ? Object.keys(data[0]) : [];
      console.log(`✅ ${table}`);
      console.log(`   Columns: ${columns.join(", ")}`);
      console.log("");
    }
  }
}

inspectTables().catch(e => console.error("Error:", e.message));
