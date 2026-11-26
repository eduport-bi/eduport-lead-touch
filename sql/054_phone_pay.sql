-- 054 (2026-11-26): precomputed payments per phone number, for the Overview statements that looked them up lead by lead.
-- analytics.mv_phone_pay: one row per phone key that has a valid payment (app, or Ujra on its own or an alternative number):
--   first_pay  = the earliest valid payment date on that number (the dashboard's "first valid payment", as min() over v_valid_payment_x)
--   latest_ay  = the academic year of the course of the LATEST valid app payment on that number that has one (core_batch.academic_year,
--                via the enrollment batch, else the batch); NULL when no payment on the number carries one (Ujra bookings, old payments)
-- Before: the never-touched leads (conv_untouched, untouched_dims) ran min(payment_date) over the 4-branch view v_valid_payment_x once per
-- lead, and conv_ay rebuilt the latest academic year from home_payment for every converted lead; these were the slowest statements of the
-- Overview top half (13-38 s locally). Now each lead is one index lookup on phone_key. Same values: the definitions are copied unchanged.
-- Refreshed by analytics.refresh_all() after mv_user_phone and mv_ujra_payment (it reads both). About 190k rows, ~15 MB.
-- Run OUTSIDE working hours (first build reads every payment).
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_phone_pay AS
WITH fp AS (
  SELECT vp.phone_key, min(vp.payment_date) AS first_pay
  FROM analytics.v_valid_payment_x vp WHERE vp.phone_key IS NOT NULL GROUP BY vp.phone_key),
ay AS (
  SELECT DISTINCT ON (up.phone_key) up.phone_key, NULLIF(btrim(b.academic_year), '') AS ay
  FROM analytics.mv_user_phone up
  JOIN app.home_payment p ON p.user_id = up.user_id
  JOIN app.core_batch b ON b.id = COALESCE(p.enrollment_batch_id, p.batch_id)
  WHERE p.payment_method = 0 AND p.deleted = false AND p.is_success = true AND p.payment_success = true AND p.payment_date IS NOT NULL
    AND NULLIF(btrim(b.academic_year), '') IS NOT NULL
  ORDER BY up.phone_key, p.payment_date DESC, p.payment_time DESC NULLS LAST, p.id DESC)
SELECT fp.phone_key, fp.first_pay, ay.ay AS latest_ay
FROM fp LEFT JOIN ay ON ay.phone_key = fp.phone_key;
@@
-- unique on phone_key: needed for REFRESH ... CONCURRENTLY (refresh_one), and the INCLUDE makes every lookup an index-only read
CREATE UNIQUE INDEX IF NOT EXISTS mv_phone_pay_pk ON analytics.mv_phone_pay (phone_key) INCLUDE (first_pay, latest_ay);
@@
ANALYZE analytics.mv_phone_pay;
@@
-- refresh_all: mv_phone_pay right after the two views it reads
CREATE OR REPLACE FUNCTION analytics.refresh_all()
 RETURNS TABLE(view_name text, row_count bigint, seconds numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'analytics', 'public'
AS $function$
DECLARE t0 timestamptz; n bigint; v text;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('analytics.refresh_all')) THEN RAISE NOTICE 'refresh_all already running'; RETURN; END IF;
  BEGIN
    FOREACH v IN ARRAY ARRAY['analytics.mv_user_phone', 'analytics.mv_ujra_payment', 'analytics.mv_phone_pay', 'analytics.mv_lead_lite', 'analytics.mv_touch_flat',
                             'analytics.mv_lead_last_touch', 'analytics.mv_ic_decision', 'analytics.mv_lead_decision', 'analytics.mv_payer',
                             'analytics.mv_payer_first_touch', 'analytics.mv_lead_class_pay'] LOOP
      t0 := clock_timestamp();
      n := analytics.refresh_one(v::regclass);
      view_name := v; row_count := n; seconds := round(EXTRACT(epoch FROM clock_timestamp() - t0)::numeric, 1);
      RETURN NEXT;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN PERFORM pg_advisory_unlock(hashtext('analytics.refresh_all')); RAISE; END;
  PERFORM pg_advisory_unlock(hashtext('analytics.refresh_all'));
END $function$;
@@
SELECT count(*) AS phones, count(latest_ay) AS with_ay, pg_size_pretty(pg_total_relation_size('analytics.mv_phone_pay')) AS size FROM analytics.mv_phone_pay
