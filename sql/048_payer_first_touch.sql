-- 048 (2026-11-05): the FIRST touch of every paying user, precomputed next to mv_payer's last-touch credit.
-- The Converted page shows every attribution card twice: by LAST touch (mv_payer.last_touch_*, the Tableau credit) and by FIRST touch - the
-- touch that brought the lead in. First touch = the EARLIEST touch, across the Salesforce leads on the account's own phone or alternative
-- number (mv_user_phone, the lead set mv_payer uses), dated on/before the user's last valid payment day; users whose touches all came after
-- the payment, or with no lead on the phone, are "No Touch Before Payment", like the last-touch columns.
-- Computed per request this cost 8-28 s for a month of payers (12k cold heap fetches on mv_lead_lite + a walk of the touch index), so it is
-- one small materialized view (one row per payer, ~150k rows), refreshed by refresh_all() right after mv_payer (its source, with
-- mv_user_phone, mv_lead_lite and mv_touch_flat, all refreshed earlier in the same run).
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_payer_first_touch AS
WITH lk AS (
  SELECT DISTINCT p.user_id, ll.lead_id, p.last_payment_date
  FROM analytics.mv_payer p
  JOIN analytics.mv_user_phone k ON k.user_id = p.user_id
  JOIN analytics.mv_lead_lite ll ON ll.phone_key = k.phone_key),
x AS (
  SELECT DISTINCT ON (lk.user_id) lk.user_id, t.touch_id, t.touch_at, t.touch_point, t.source, t.medium, t.campaign, t.staff
  FROM lk JOIN analytics.mv_touch_flat t ON t.lead_id = lk.lead_id
  WHERE t.touch_date <= lk.last_payment_date
  ORDER BY lk.user_id, t.touch_at, t.touch_id)
SELECT p.user_id, x.touch_id AS first_touch_id, x.touch_at AS first_touch_at,
       COALESCE(x.touch_point, 'No Touch Before Payment') AS first_touch_point,
       COALESCE(x.source,      'No Touch Before Payment') AS first_touch_source,
       COALESCE(x.medium,      'No Touch Before Payment') AS first_touch_medium,
       COALESCE(x.campaign,    'No Touch Before Payment') AS first_touch_campaign,
       COALESCE(x.staff,       CASE WHEN x.touch_id IS NULL THEN 'No Touch Before Payment' ELSE '(Blank)' END) AS first_touch_staff
FROM analytics.mv_payer p
LEFT JOIN x ON x.user_id = p.user_id
WITH DATA;
CREATE UNIQUE INDEX IF NOT EXISTS mv_payer_first_touch_pk ON analytics.mv_payer_first_touch (user_id);
ANALYZE analytics.mv_payer_first_touch;
@@
-- refresh order: sources first, then the big ones, the per-lead summaries, the payer table and its first-touch companion
CREATE OR REPLACE FUNCTION analytics.refresh_all()
RETURNS TABLE(view_name text, row_count bigint, seconds numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = analytics, public AS $$
DECLARE t0 timestamptz; n bigint; v text;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('analytics.refresh_all')) THEN RAISE NOTICE 'refresh_all already running'; RETURN; END IF;
  BEGIN
    FOREACH v IN ARRAY ARRAY['analytics.mv_user_phone', 'analytics.mv_ujra_payment', 'analytics.mv_lead_lite', 'analytics.mv_touch_flat',
                             'analytics.mv_lead_last_touch', 'analytics.mv_ic_decision', 'analytics.mv_lead_decision', 'analytics.mv_payer',
                             'analytics.mv_payer_first_touch'] LOOP
      t0 := clock_timestamp();
      n := analytics.refresh_one(v::regclass);
      view_name := v; row_count := n; seconds := round(EXTRACT(epoch FROM clock_timestamp() - t0)::numeric, 1);
      RETURN NEXT;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN PERFORM pg_advisory_unlock(hashtext('analytics.refresh_all')); RAISE; END;
  PERFORM pg_advisory_unlock(hashtext('analytics.refresh_all'));
END $$;
@@
SELECT count(*) AS payers, count(first_touch_id) AS with_first_touch,
       count(*) FILTER (WHERE first_touch_point = 'No Touch Before Payment') AS no_touch_before_payment,
       pg_size_pretty(pg_total_relation_size('analytics.mv_payer_first_touch')) AS size
FROM analytics.mv_payer_first_touch
