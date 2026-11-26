-- 055 (2026-11-26): one lead_id index on analytics.mv_lead_lite instead of three.
-- The view carried three B-trees on the same column, added at different times (sql/035 pk; the partial "nodup" index for the
-- duplicate filter; sql/040 pk_phone so the phone lookups read the index only): 64 + 62 + 80 MB = 206 MB, most of it read from disk on
-- the Micro compute (256 MB of shared buffers). One unique index carrying every column those three served replaces them:
--   lead_id UNIQUE (REFRESH ... CONCURRENTLY needs a unique, non-partial index)  INCLUDE (phone_key, phone_valid, is_duplicate)
-- so a lookup by lead_id with or without the duplicate filter, and the phone lookups, stay index-only. About 85 MB.
-- Run OUTSIDE working hours: the build reads the whole view, and the drops take a short exclusive lock (readers wait a moment).
-- Chunks run one by one, each in its own transaction (ltsql-local / the workflow's sql input); the swap is one chunk, so it is atomic.
CREATE UNIQUE INDEX IF NOT EXISTS mv_lead_lite_pk_new ON analytics.mv_lead_lite (lead_id) INCLUDE (phone_key, phone_valid, is_duplicate);
@@
DROP INDEX IF EXISTS analytics.mv_lead_lite_pk_phone;
DROP INDEX IF EXISTS analytics.mv_lead_lite_nodup;
DROP INDEX IF EXISTS analytics.mv_lead_lite_pk;
ALTER INDEX analytics.mv_lead_lite_pk_new RENAME TO mv_lead_lite_pk;
@@
ANALYZE analytics.mv_lead_lite;
@@
SELECT indexname, pg_size_pretty(pg_relation_size(('analytics.' || indexname)::regclass)) AS size, indexdef
FROM pg_indexes WHERE schemaname = 'analytics' AND tablename = 'mv_lead_lite' ORDER BY 1
