-- 051 (2026-11-23): the classes each lead's number has PAID for, with the payment dates (global "Purchased class" switch of the filter bar).
-- With the switch on "Purchased class", a picked Class means "the lead's number paid for a course of that class" instead of "the Class on the
-- Salesforce lead", and the conversion tiles use the date of THAT class payment (Total converted: on/after a touch and not before the window
-- start; Converted before the window: before the window start). Computed per request this cost 20-40 s on a month, so it is one small
-- materialized view: one row per (lead, base class, payment day).
--   payments : valid app payments, dashboard rule (payment_method 0, not deleted, is_success, payment_success), on the batch of the enrollment
--              (else the batch written on the payment); Ujra bookings carry no batch and are left out (a picked lead class is never "Integrated")
--   leads    : every lead on the paying account's own phone or alternative number (mv_user_phone -> mv_lead_lite.phone_key, valid phones only)
--   base     : the base class of the batch grade, as the Converted page's class view: "Class 10", "Class 12", "Repeater", "KEAM/JEE Crash" ...
-- Chunk 1 creates it (run 2026-11-23 for the class-view preview; nothing live reads it). Chunk 2 adds it to refresh_all() and is run at deploy.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_lead_class_pay AS
WITH b AS (
  SELECT cb.id, COALESCE(substring(analytics.class_group(cb.grade_title) from '^Class [0-9]+'), analytics.class_group(cb.grade_title)) AS base_class
  FROM app.core_batch cb WHERE cb.grade_title IS NOT NULL)
SELECT DISTINCT ll.lead_id, b.base_class, p.payment_date
FROM app.home_payment p
JOIN b ON b.id = COALESCE(p.enrollment_batch_id, p.batch_id)
JOIN analytics.mv_user_phone up ON up.user_id = p.user_id
JOIN analytics.mv_lead_lite ll ON ll.phone_key = up.phone_key AND ll.phone_valid
WHERE p.payment_method = 0 AND p.deleted = false AND p.is_success = true AND p.payment_success = true AND p.payment_date IS NOT NULL
WITH DATA;
CREATE UNIQUE INDEX IF NOT EXISTS mv_lead_class_pay_pk ON analytics.mv_lead_class_pay (lead_id, base_class, payment_date);
CREATE INDEX IF NOT EXISTS mv_lead_class_pay_class ON analytics.mv_lead_class_pay (base_class, payment_date, lead_id);
ANALYZE analytics.mv_lead_class_pay;
@@
SELECT count(*) AS rows_, count(DISTINCT lead_id) AS leads, count(DISTINCT base_class) AS classes,
       pg_size_pretty(pg_total_relation_size('analytics.mv_lead_class_pay')) AS size
FROM analytics.mv_lead_class_pay
@@
-- CHUNK 2, AT DEPLOY ONLY: refresh it nightly, after mv_lead_lite and mv_user_phone (its sources)
CREATE OR REPLACE FUNCTION analytics.refresh_all()
RETURNS TABLE(view_name text, row_count bigint, seconds numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = analytics, public AS $$
DECLARE t0 timestamptz; n bigint; v text;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('analytics.refresh_all')) THEN RAISE NOTICE 'refresh_all already running'; RETURN; END IF;
  BEGIN
    FOREACH v IN ARRAY ARRAY['analytics.mv_user_phone', 'analytics.mv_ujra_payment', 'analytics.mv_lead_lite', 'analytics.mv_touch_flat',
                             'analytics.mv_lead_last_touch', 'analytics.mv_ic_decision', 'analytics.mv_lead_decision', 'analytics.mv_payer',
                             'analytics.mv_payer_first_touch', 'analytics.mv_lead_class_pay'] LOOP
      t0 := clock_timestamp();
      n := analytics.refresh_one(v::regclass);
      view_name := v; row_count := n; seconds := round(EXTRACT(epoch FROM clock_timestamp() - t0)::numeric, 1);
      RETURN NEXT;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN PERFORM pg_advisory_unlock(hashtext('analytics.refresh_all')); RAISE; END;
  PERFORM pg_advisory_unlock(hashtext('analytics.refresh_all'));
END $$;
