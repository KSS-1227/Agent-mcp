-- Raise per-key ceilings well clear of anything judging can produce.
--
-- Judging runs 19 August to 15 September, and a judge who meets a 429 sees a
-- broken project rather than a rate limit. An adjudication costs roughly
-- $0.002, so 25 dollars a key is about twelve thousand rulings — more than a
-- judge could generate deliberately, let alone by accident.
--
-- Applies to keys already issued as well as new ones. A judge who took a key on
-- day one and returns in September should not be carrying the old, tighter
-- allowance while everyone else has the new one.
--
-- The ceilings stay rather than being removed. Key issuance is unauthenticated
-- by design so that anyone can evaluate this without asking permission, which
-- means a script has the same access a judge does. A limit nobody legitimate can
-- reach costs nothing; no limit at all is an unbounded bill on somebody's card
-- with nobody watching it for a month.

SET database = interlock;

ALTER TABLE api_key ALTER COLUMN daily_call_limit SET DEFAULT 10000;
ALTER TABLE api_key ALTER COLUMN daily_usd_limit  SET DEFAULT 25;

UPDATE api_key
   SET daily_call_limit = 10000
 WHERE daily_call_limit < 10000;

UPDATE api_key
   SET daily_usd_limit = 25
 WHERE daily_usd_limit < 25;
