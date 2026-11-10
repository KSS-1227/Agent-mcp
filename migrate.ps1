param([Parameter(Mandatory)][ValidateSet('test','prod')][string]$Target)
$cfg = @{
  test = @{ file='.env.crash-test'; var='TEST_DATABASE_URL'; user='postgres.omccomlpjpvafmuwgyqs'; dbhost='aws-0-ap-northeast-1.pooler.supabase.com:5432' }
  prod = @{ file='.env';            var='DATABASE_URL';      user='postgres.qrybckrzzzfhgqthxnpu'; dbhost='aws-0-ap-southeast-2.pooler.supabase.com:5432' }
}[$Target]
Push-Location (Join-Path $PSScriptRoot 'agent-safety-mcp')
try {
  Remove-Item Env:TEST_DATABASE_URL, Env:TEST_SUPABASE_URL, Env:TEST_SUPABASE_SERVICE_ROLE_KEY, Env:RUN_LIVE_DB_TESTS, Env:DATABASE_URL -ErrorAction SilentlyContinue
  $l = Select-String -Path $cfg.file -Pattern ('^\s*' + $cfg.var + '\s*=(.*)$') | Select-Object -First 1
  if (-not $l) { throw "$($cfg.var) not found in $($cfg.file)" }
  $s = $l.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
  $u = if ($s -match '^postgres(?:ql)?://([^:]+):') { $matches[1] }
  $h = if ($s -match '.*@([^@/]+)/') { $matches[1] }
  "target: $Target  user: $u  host: $h"
  if ($u -ne $cfg.user -or $h -ne $cfg.dbhost) { throw "TARGET MISMATCH - expected $($cfg.user) on $($cfg.dbhost). Nothing was run." }
  if ($Target -eq 'prod') { if ((Read-Host "This changes PRODUCTION. Type PROD to continue") -ne 'PROD') { throw "Cancelled." } }
  $env:DATABASE_URL = $s
  $env:RUN_DATABASE_MIGRATIONS = '1'
  npm run db:migrate
} finally {
  Remove-Item Env:DATABASE_URL, Env:RUN_DATABASE_MIGRATIONS -ErrorAction SilentlyContinue
  "DATABASE_URL set: " + [bool]$env:DATABASE_URL
  Pop-Location
}
