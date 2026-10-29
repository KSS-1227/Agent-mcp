-- =============================================================================
-- INTERLOCK — multi-region topology
--
-- Cluster regions: aws-us-east-1, aws-us-east-2, aws-us-west-2
--
-- WHY THREE. SURVIVE REGION FAILURE needs a quorum of replicas to remain after
-- a region is lost. With two regions there is no quorum left, so two regions
-- can only ever give you SURVIVE ZONE FAILURE. Three is the minimum at which
-- the chaos drill — kill a region mid-adjudication and watch the decision still
-- land, exactly once — is a real demonstration rather than a staged one.
--
-- THE LOCALITY TRADE-OFF. Region survival is not free: a table configured to
-- survive a region loss needs cross-region consensus on every write, which adds
-- latency. Since the headline claim of this project is a throughput and cost
-- measurement, letting every table pay that cost would quietly corrupt the very
-- numbers we are arguing about.
--
-- So localities are assigned deliberately:
--
--   benchmark tables      → REGIONAL BY TABLE IN "aws-us-east-1"
--                           writes stay local, measurements stay honest
--   decision-record tables → REGIONAL BY TABLE IN PRIMARY REGION, and the
--                           database survives region failure, so no adjudication
--                           is lost when a region goes away
--   reference tables      → GLOBAL, read from anywhere at low latency
--
-- Being explicit about this is the point: a system that claims resilience and
-- speed at once should be able to show exactly where it bought each one.
-- =============================================================================

SET database = interlock;

-- -----------------------------------------------------------------------------
-- Database-level topology
--
-- Cluster regions exist as hardware; the database still has to opt in to them.
-- These statements are idempotent enough to re-run: adding a region that is
-- already present errors, so the runner tolerates "already exists" here.
-- -----------------------------------------------------------------------------

ALTER DATABASE interlock SET PRIMARY REGION "aws-us-east-1";
ALTER DATABASE interlock ADD REGION IF NOT EXISTS "aws-us-east-2";
ALTER DATABASE interlock ADD REGION IF NOT EXISTS "aws-us-west-2";

-- The whole point of the drill.
ALTER DATABASE interlock SURVIVE REGION FAILURE;

-- -----------------------------------------------------------------------------
-- Per-table locality
-- -----------------------------------------------------------------------------

-- Read constantly by every agent in every region, written rarely.
ALTER TABLE agent SET LOCALITY GLOBAL;

-- The contended world state. Homed in the primary region so the benchmark
-- measures concurrency control, not wide-area network latency.
ALTER TABLE resource SET LOCALITY REGIONAL BY TABLE IN "aws-us-east-1";

-- The decision record. These must survive a region loss — an adjudication that
-- vanishes because a datacentre went away is the exact failure this project
-- claims to prevent.
ALTER TABLE intent           SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
ALTER TABLE intent_read      SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
ALTER TABLE plan_step        SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
ALTER TABLE provenance_edge  SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
ALTER TABLE commit_log       SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
ALTER TABLE adjudication     SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
ALTER TABLE repair           SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;

-- Benchmark bookkeeping stays local and cheap; losing a benchmark row costs
-- nothing, and paying cross-region latency to record a measurement would
-- distort the measurement.
ALTER TABLE bench_run   SET LOCALITY REGIONAL BY TABLE IN "aws-us-east-1";
ALTER TABLE bench_event SET LOCALITY REGIONAL BY TABLE IN "aws-us-east-1";
