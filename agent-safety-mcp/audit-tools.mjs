/**
 * Tool Registry Audit
 * Programmatically counts all registered tools
 */

if (process.env.RUN_MANUAL_DB_DIAGNOSTICS !== '1') throw new Error('Set RUN_MANUAL_DB_DIAGNOSTICS=1 to run this manual application diagnostic');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is not accepted');
if (!process.env.TEST_SUPABASE_URL || !process.env.TEST_SUPABASE_SERVICE_ROLE_KEY) throw new Error('TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY are required');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SUPABASE_URL = process.env.TEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

console.log("🔍 TOOL REGISTRY AUDIT\n");

try {
  const { createMCPServer } = await import("./dist/mcp/server.js");
  
  console.log("Creating MCP server...");
  const server = await createMCPServer();
  
  const handlers = server._requestHandlers || new Map();
  const toolsListHandler = handlers.get("tools/list");
  
  if (!toolsListHandler) {
    console.error("❌ tools/list handler not found");
    process.exit(1);
  }

  const toolsResult = await toolsListHandler();
  const tools = toolsResult?.tools || [];
  
  console.log(`\n✅ Found ${tools.length} tools\n`);
  
  // Group by category
  const toolsByName = {};
  tools.forEach(tool => {
    const category = tool.name.split("_")[0];
    if (!toolsByName[category]) toolsByName[category] = [];
    toolsByName[category].push(tool.name);
  });
  
  // Print organized
  Object.keys(toolsByName).sort().forEach(cat => {
    console.log(`${cat.toUpperCase()}: ${toolsByName[cat].length} tools`);
    toolsByName[cat].forEach(name => console.log(`  - ${name}`));
  });
  
  // Check for duplicates
  const toolNames = tools.map(t => t.name);
  const unique = new Set(toolNames);
  
  console.log(`\n📊 Summary:`);
  console.log(`   Total: ${toolNames.length}`);
  console.log(`   Unique: ${unique.size}`);
  
  if (unique.size !== toolNames.length) {
    const dups = toolNames.filter((t, i) => toolNames.indexOf(t) !== i);
    console.log(`   ⚠️  Duplicates: ${[...new Set(dups)].join(", ")}`);
  } else {
    console.log(`   ✅ No duplicates`);
  }

} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`\n❌ Audit failed: ${msg}`);
  process.exit(1);
}
