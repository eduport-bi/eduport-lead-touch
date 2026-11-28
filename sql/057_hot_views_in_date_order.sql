-- 057 (2026-11-28): store the two views the dashboard reads most in date order, so a date window reads only its own pages.
--
-- Why: the rows of mv_touch_flat and mv_lead_lite were in random order (pg_stats correlation of touch_date / created_at ~ 0), so a 30-day
-- window touched 16k of the 18.7k pages of mv_touch_flat: every Overview statement read ~150 MB, mostly from disk (Micro compute keeps
-- 256 MB in memory). In date order a 30-day window is a few thousand neighbouring pages, and the recent months every user looks at stay
-- in memory. There was also no index on lead_created_date (the default "Created" basis), so that basis always read the whole view.
--
-- CLUSTER rewrites the view in index order and drops its dead space. It holds an exclusive lock while it runs (dashboard queries on that
-- view wait): run this outside working hours. The nightly sync repeats the CLUSTER after its refresh (sync/src/sync.ts, refreshViews),
-- because REFRESH CONCURRENTLY changes rows in place and the order decays.
-- Nothing is deleted: CLUSTER keeps every row.

-- the Created basis (lead created date) gets its own index; touch_date already has mv_touch_flat_date
CREATE INDEX IF NOT EXISTS mv_touch_flat_created ON analytics.mv_touch_flat (lead_created_date);
@@
SET lock_timeout = '1min';
CLUSTER analytics.mv_touch_flat USING mv_touch_flat_date;
@@
SET lock_timeout = '1min';
CLUSTER analytics.mv_lead_lite USING mv_lead_lite_created_inc;
@@
-- CLUSTER writes a new file without a visibility map; vacuum it so the index-only counts stay index-only
VACUUM (ANALYZE) analytics.mv_touch_flat;
@@
VACUUM (ANALYZE) analytics.mv_lead_lite;
@@
-- check: correlation near 1 = in date order
SELECT tablename, attname, round(correlation::numeric, 3) AS correlation
FROM pg_stats WHERE schemaname = 'analytics'
  AND ((tablename = 'mv_touch_flat' AND attname IN ('touch_date', 'lead_created_date')) OR (tablename = 'mv_lead_lite' AND attname = 'created_at'));
