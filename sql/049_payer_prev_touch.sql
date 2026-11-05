-- 049 (2026-11-06): the touch BEFORE the credited last touch of every paying user, next to its first touch (sql/048).
-- Converted page: "App Installed" is the last-touch source of over half the paying users, and an app install says little about what brought
-- the student. The new card splits those users by the source of the touch just before the credited last touch (the previous touch, latest
-- touch with touch_at < last_touch_at, dated on/before the last valid payment day, across the same lead set); "No Earlier Touch" when the
-- credited touch was the only one. Stored in analytics.mv_payer_first_touch (name kept: refresh_all already lists it right after mv_payer),
-- which is dropped and rebuilt here with the extra columns - a materialized view cannot add a column in place.
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_payer_first_touch;
CREATE MATERIALIZED VIEW analytics.mv_payer_first_touch AS
WITH lk AS (
  SELECT DISTINCT p.user_id, ll.lead_id, p.last_payment_date, p.last_touch_at
  FROM analytics.mv_payer p
  JOIN analytics.mv_user_phone k ON k.user_id = p.user_id
  JOIN analytics.mv_lead_lite ll ON ll.phone_key = k.phone_key),
x AS (
  SELECT DISTINCT ON (lk.user_id) lk.user_id, t.touch_id, t.touch_at, t.touch_point, t.source, t.medium, t.campaign, t.staff
  FROM lk JOIN analytics.mv_touch_flat t ON t.lead_id = lk.lead_id
  WHERE t.touch_date <= lk.last_payment_date
  ORDER BY lk.user_id, t.touch_at, t.touch_id),
pv AS (
  SELECT DISTINCT ON (lk.user_id) lk.user_id, t.touch_id, t.touch_at, t.touch_point, t.source, t.medium, t.campaign, t.staff
  FROM lk JOIN analytics.mv_touch_flat t ON t.lead_id = lk.lead_id
  WHERE lk.last_touch_at IS NOT NULL AND t.touch_at < lk.last_touch_at AND t.touch_date <= lk.last_payment_date
  ORDER BY lk.user_id, t.touch_at DESC, t.touch_id DESC)
SELECT p.user_id, x.touch_id AS first_touch_id, x.touch_at AS first_touch_at,
       COALESCE(x.touch_point, 'No Touch Before Payment') AS first_touch_point,
       COALESCE(x.source,      'No Touch Before Payment') AS first_touch_source,
       COALESCE(x.medium,      'No Touch Before Payment') AS first_touch_medium,
       COALESCE(x.campaign,    'No Touch Before Payment') AS first_touch_campaign,
       COALESCE(x.staff,       CASE WHEN x.touch_id IS NULL THEN 'No Touch Before Payment' ELSE '(Blank)' END) AS first_touch_staff,
       pv.touch_id AS prev_touch_id, pv.touch_at AS prev_touch_at,
       COALESCE(pv.touch_point, 'No Earlier Touch') AS prev_touch_point,
       COALESCE(pv.source,      'No Earlier Touch') AS prev_touch_source,
       COALESCE(pv.medium,      'No Earlier Touch') AS prev_touch_medium,
       COALESCE(pv.campaign,    'No Earlier Touch') AS prev_touch_campaign,
       COALESCE(pv.staff,       CASE WHEN pv.touch_id IS NULL THEN 'No Earlier Touch' ELSE '(Blank)' END) AS prev_touch_staff
FROM analytics.mv_payer p
LEFT JOIN x  ON x.user_id = p.user_id
LEFT JOIN pv ON pv.user_id = p.user_id
WITH DATA;
CREATE UNIQUE INDEX mv_payer_first_touch_pk ON analytics.mv_payer_first_touch (user_id);
ANALYZE analytics.mv_payer_first_touch;
@@
SELECT count(*) AS payers, count(first_touch_id) AS with_first_touch, count(prev_touch_id) AS with_prev_touch,
       count(*) FILTER (WHERE prev_touch_source = 'No Earlier Touch' AND first_touch_id IS NOT NULL) AS single_touch_users,
       pg_size_pretty(pg_total_relation_size('analytics.mv_payer_first_touch')) AS size
FROM analytics.mv_payer_first_touch
