import { createClient } from "@supabase/supabase-js";
if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== "1") {
  throw new Error("Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual Supabase diagnostic");
}
if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required as the diagnostic database opt-in");
}

const url = process.env.TEST_SUPABASE_URL;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey || url.includes("your-")) {
  console.error("❌ Credentials not found or still placeholders");
  process.exit(1);
}

console.log("✅ Credentials loaded\n");

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const tables = [
  "agents", "tasks", "resources", "intents", "intent_reads", "intent_steps",
  "conflicts", "actions", "action_evidence", "episodes", "managed_clusters", "action_intents"
];

async function testTableAccess() {
  console.log("🔍 Testing RLS Access on All Tables\n");
  
  const rlsIssues = [];
  const working = [];

  for (const table of tables) {
    try {
      const { error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true })
        .limit(1);

      if (error) {
        console.log(`❌ ${table.padEnd(20)} - ${error.message.substring(0, 50)}`);
        rlsIssues.push(table);
      } else {
        console.log(`✅ ${table}`);
        working.push(table);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ ${table.padEnd(20)} - Exception`);
      rlsIssues.push(table);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`\n📊 Summary:`);
  console.log(`✅ Working Tables: ${working.length}/${tables.length}`);
  if (working.length > 0) console.log(`   ${working.join(", ")}\n`);
  
  if (rlsIssues.length > 0) {
    console.log(`❌ Tables with RLS/Access Issues: ${rlsIssues.length}`);
    console.log(`   ${rlsIssues.join(", ")}\n`);
    
    console.log("=" .repeat(70));
    console.log("\n🔧 COPY & PASTE THIS INTO SUPABASE SQL EDITOR:\n");
    console.log("-- Disable RLS on all problematic tables");
    rlsIssues.forEach(table => {
      console.log(`ALTER TABLE public.${table} DISABLE ROW LEVEL SECURITY;`);
    });
    console.log("\n-- Then verify with:");
    rlsIssues.forEach(table => {
      console.log(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = '${table}';`);
    });
  } else {
    console.log("✅ All tables are accessible! No RLS issues found.\n");
  }
  
  console.log("\n" + "=".repeat(70));
}

testTableAccess().catch(e => {
  console.error("❌ Fatal error:", e.message);
  process.exit(1);
});
