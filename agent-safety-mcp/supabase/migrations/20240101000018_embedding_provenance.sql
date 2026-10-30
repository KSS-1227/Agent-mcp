-- Track the vector space used by each stored embedding. Keep the existing
-- vector(1024) columns and cosine indexes unchanged.
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS embedding_provider TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

ALTER TABLE intents
  ADD COLUMN IF NOT EXISTS embedding_provider TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Historical vectors predate provider metadata. Mark them explicitly as
-- unverified so searches never compare them to a named provider/model until
-- an operator re-embeds their preserved narrative/statement.
UPDATE episodes
   SET embedding_provider = 'legacy', embedding_model = 'unverified'
 WHERE embedding IS NOT NULL
   AND (embedding_provider IS NULL OR embedding_model IS NULL);

UPDATE intents
   SET embedding_provider = 'legacy', embedding_model = 'unverified'
 WHERE embedding IS NOT NULL
   AND (embedding_provider IS NULL OR embedding_model IS NULL);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'episodes_embedding_provenance_pair'
       AND conrelid = 'episodes'::regclass
  ) THEN
    ALTER TABLE episodes ADD CONSTRAINT episodes_embedding_provenance_pair CHECK (
      (embedding IS NULL AND embedding_provider IS NULL AND embedding_model IS NULL) OR
      (embedding IS NOT NULL AND embedding_provider IS NOT NULL AND embedding_model IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'intents_embedding_provenance_pair'
       AND conrelid = 'intents'::regclass
  ) THEN
    ALTER TABLE intents ADD CONSTRAINT intents_embedding_provenance_pair CHECK (
      (embedding IS NULL AND embedding_provider IS NULL AND embedding_model IS NULL) OR
      (embedding IS NOT NULL AND embedding_provider IS NOT NULL AND embedding_model IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_episodes_embedding_provenance
  ON episodes (embedding_provider, embedding_model) WHERE embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intents_embedding_provenance
  ON intents (embedding_provider, embedding_model) WHERE embedding IS NOT NULL;
