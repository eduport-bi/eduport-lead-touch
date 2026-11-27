-- 056: the 30-minute app rule on the Converted page credit (user, 2026-11-27; replaces the 2-hour rule of sql/021)
-- Applied on 2026-11-27 at 16:11 IST (the single-transaction drop-and-rebuild form, run from the Supabase SQL editor). This file
-- keeps the build-then-swap form for any re-run: the Converted page keeps its old figures until the swap.
-- An Eduport App touch made less than 30 minutes before the payment gets no credit: the touch before it is credited, and with no touch
-- before it the user is "No Touch Before Payment". An app touch more than 30 minutes before the payment is credited as usual. Applies to
-- the last-touch and the first-touch cards. The Overview applies the same rule in its queries (appQuickTouch, api/src/routes/overview.ts).
--
-- Build-then-swap: chunk 1 builds the new tables NEXT TO the live ones (mv_payer_new, mv_payer_first_touch_new) - the live tables are
-- not touched or locked, so the Converted page keeps showing the old figures while it runs; if it fails, nothing changes. Chunk 2 is
-- the check. Chunk 3 swaps them in one short transaction (drop old, rename new, rename indexes) - a fraction of a second.
-- Both views are recreated from their live definitions (pg_get_viewdef on 2026-11-27) with only the rule changed; indexes and the
-- metabase_ro read grant are the same. analytics.refresh_all refreshes them by name, so the nightly refresh needs no change.

DROP MATERIALIZED VIEW IF EXISTS analytics.mv_payer_first_touch_new;
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_payer_new;

CREATE MATERIALIZED VIEW analytics.mv_payer_new AS
WITH pay AS (
         SELECT vp.user_id,
            (array_agg(vp.phone_key ORDER BY (vp.source = 'app'::text) DESC, vp.phone_key))[1] AS phone_key,
            min(vp.payment_date) AS first_payment_date,
            max(vp.payment_date) AS last_payment_date,
            max(
                CASE
                    WHEN vp.payment_time IS NOT NULL THEN vp.payment_time
                    WHEN (vp.payment_created AT TIME ZONE 'Asia/Kolkata'::text)::date = vp.payment_date THEN vp.payment_created
                    ELSE ((vp.payment_date + 1)::timestamp without time zone AT TIME ZONE 'Asia/Kolkata'::text)
                END) AS last_payment_at,
            count(*)::integer AS payments,
            sum(vp.amount) AS revenue,
            count(*) FILTER (WHERE vp.payment_method = 0)::integer AS payments_m0,
            count(*) FILTER (WHERE vp.payment_method <> 0)::integer AS payments_m1,
            min(vp.payment_date) FILTER (WHERE vp.payment_method = 0) AS first_payment_date_m0,
            string_agg(DISTINCT COALESCE(b.title, vp.course_label, 'batch '::text || vp.batch_id::text), ' | '::text) AS courses,
            string_agg(DISTINCT COALESCE(b.grade_title, vp.grade_label, 'No Grade On Batch'::text), ' | '::text) AS grades,
            bool_or(vp.source = 'ujra'::text) AS has_ujra,
            bool_or(vp.source = 'app'::text) AS has_app
           FROM analytics.v_paid_any vp
             LEFT JOIN app.core_batch b ON b.id = vp.batch_id
          WHERE vp.user_id IS NOT NULL
          GROUP BY vp.user_id
        ), leads AS (
         SELECT c.lead_id,
            c.phone_key,
            c.lead_name,
            c.lead_stage,
            c.class_raw,
            c.class_group,
            c.lead_source,
            c.owner_name,
            c.created_at
           FROM analytics.v_lead_conv c
          WHERE c.phone_key IS NOT NULL
        ), ul AS (
         SELECT DISTINCT p_1.user_id,
            l.lead_id,
            l.phone_key,
            l.lead_name,
            l.lead_stage,
            l.class_raw,
            l.class_group,
            l.lead_source,
            l.owner_name,
            l.created_at
           FROM pay p_1
             JOIN analytics.v_user_phone up ON up.user_id = p_1.user_id
             JOIN leads l ON l.phone_key = up.phone_key
        ), lead1 AS (
         SELECT DISTINCT ON (ul.user_id) ul.user_id,
            ul.lead_id,
            ul.phone_key,
            ul.lead_name,
            ul.lead_stage,
            ul.class_raw,
            ul.class_group,
            ul.lead_source,
            ul.owner_name,
            ul.created_at
           FROM ul
          ORDER BY ul.user_id, ul.created_at DESC
        ), touches AS (
         SELECT ul.user_id,
            t.touch_id,
            t.touch_at,
            t.touch_date,
            t.touch_point,
            t.source,
            t.medium,
            t.campaign,
            t.staff,
            t.lead_id
           FROM ul
             JOIN analytics.mv_touch_flat t ON t.lead_id::text = ul.lead_id::text
        ), lt AS (
         SELECT DISTINCT ON (x.user_id) x.user_id,
            x.touch_id,
            x.touch_at,
            x.touch_date,
            x.touch_point,
            x.source,
            x.medium,
            x.campaign,
            x.staff,
            x.lead_id,
            x.rank_app
           FROM ( SELECT x_1.user_id,
                    x_1.touch_id,
                    x_1.touch_at,
                    x_1.touch_date,
                    x_1.touch_point,
                    x_1.source,
                    x_1.medium,
                    x_1.campaign,
                    x_1.staff,
                    x_1.lead_id,
                        CASE
                            WHEN x_1.touch_point = 'Eduport App'::text AND x_1.touch_at > (p_1.last_payment_at - '00:30:00'::interval) THEN 1
                            ELSE 0
                        END AS rank_app
                   FROM touches x_1
                     JOIN pay p_1 USING (user_id)
                  WHERE x_1.touch_date <= p_1.last_payment_date) x
          ORDER BY x.user_id, x.rank_app, x.touch_at DESC, x.touch_id DESC
        ), ntb AS (
         SELECT x.user_id,
            count(*) FILTER (WHERE x.touch_date <= p_1.last_payment_date)::integer AS touches_on_before
           FROM touches x
             JOIN pay p_1 USING (user_id)
          GROUP BY x.user_id
        )
 SELECT p.user_id,
    p.phone_key,
    p.first_payment_date,
    p.last_payment_date,
    p.last_payment_at,
    p.payments,
    p.revenue,
    p.courses,
    p.grades,
    p.has_ujra,
    p.has_app,
    p.payments_m0,
    p.payments_m1,
    p.first_payment_date_m0,
    lead1.lead_id,
    lead1.lead_name,
    lead1.lead_stage,
    lead1.class_raw,
    lead1.class_group,
    lead1.lead_source,
    lead1.owner_name,
    lead1.lead_id IS NULL AS no_lead,
    lt.touch_at AS last_touch_at,
    lt.touch_id AS last_touch_id,
    COALESCE(lt.touch_point, 'No Touch Before Payment'::text) AS last_touch_point,
    COALESCE(lt.source, 'No Touch Before Payment'::text) AS last_touch_source,
    COALESCE(lt.medium, 'No Touch Before Payment'::text) AS last_touch_medium,
    COALESCE(lt.campaign, 'No Touch Before Payment'::text) AS last_touch_campaign,
    COALESCE(lt.staff,
        CASE
            WHEN lt.touch_id IS NULL THEN 'No Touch Before Payment'::text
            ELSE '(Blank)'::text
        END) AS last_touch_staff,
    COALESCE(ntb.touches_on_before, 0) AS touches_before_payment
   FROM pay p
     LEFT JOIN lead1 USING (user_id)
     LEFT JOIN lt ON lt.user_id = p.user_id
          -- 30-minute rule (2026-11-27): an Eduport App touch less than 30 minutes before the last payment (rank_app = 1) is never
          -- credited; the touch before it is (rank_app = 0 sorts first), and with none the user is "No Touch Before Payment"
          AND lt.rank_app = 0
     LEFT JOIN ntb ON ntb.user_id = p.user_id;
CREATE UNIQUE INDEX mv_payer_new_pk ON analytics.mv_payer_new USING btree (user_id);
CREATE INDEX mv_payer_new_last_pay ON analytics.mv_payer_new USING btree (last_payment_date);
CREATE INDEX mv_payer_new_phone ON analytics.mv_payer_new USING btree (phone_key);
ANALYZE analytics.mv_payer_new;

CREATE MATERIALIZED VIEW analytics.mv_payer_first_touch_new AS
WITH lk AS (
         SELECT DISTINCT p_1.user_id,
            ll.lead_id,
            p_1.last_payment_date,
            p_1.last_payment_at,
            p_1.last_touch_at
           FROM analytics.mv_payer_new p_1
             JOIN analytics.mv_user_phone k ON k.user_id = p_1.user_id
             JOIN analytics.mv_lead_lite ll ON ll.phone_key = k.phone_key
        ), x AS (
         SELECT DISTINCT ON (lk.user_id) lk.user_id,
            t.touch_id,
            t.touch_at,
            t.touch_point,
            t.source,
            t.medium,
            t.campaign,
            t.staff
           FROM lk
             JOIN analytics.mv_touch_flat t ON t.lead_id::text = lk.lead_id::text
          WHERE t.touch_date <= lk.last_payment_date
            -- 30-minute rule (2026-11-27): an Eduport App touch less than 30 minutes before the last payment is never credited
            AND NOT (t.touch_point = 'Eduport App'::text AND t.touch_at > (lk.last_payment_at - '00:30:00'::interval))
          ORDER BY lk.user_id, t.touch_at, t.touch_id
        ), pv AS (
         SELECT DISTINCT ON (lk.user_id) lk.user_id,
            t.touch_id,
            t.touch_at,
            t.touch_point,
            t.source,
            t.medium,
            t.campaign,
            t.staff
           FROM lk
             JOIN analytics.mv_touch_flat t ON t.lead_id::text = lk.lead_id::text
          WHERE lk.last_touch_at IS NOT NULL AND t.touch_at < lk.last_touch_at AND t.touch_date <= lk.last_payment_date
          ORDER BY lk.user_id, t.touch_at DESC, t.touch_id DESC
        )
 SELECT p.user_id,
    x.touch_id AS first_touch_id,
    x.touch_at AS first_touch_at,
    COALESCE(x.touch_point, 'No Touch Before Payment'::text) AS first_touch_point,
    COALESCE(x.source, 'No Touch Before Payment'::text) AS first_touch_source,
    COALESCE(x.medium, 'No Touch Before Payment'::text) AS first_touch_medium,
    COALESCE(x.campaign, 'No Touch Before Payment'::text) AS first_touch_campaign,
    COALESCE(x.staff,
        CASE
            WHEN x.touch_id IS NULL THEN 'No Touch Before Payment'::text
            ELSE '(Blank)'::text
        END) AS first_touch_staff,
    pv.touch_id AS prev_touch_id,
    pv.touch_at AS prev_touch_at,
    COALESCE(pv.touch_point, 'No Earlier Touch'::text) AS prev_touch_point,
    COALESCE(pv.source, 'No Earlier Touch'::text) AS prev_touch_source,
    COALESCE(pv.medium, 'No Earlier Touch'::text) AS prev_touch_medium,
    COALESCE(pv.campaign, 'No Earlier Touch'::text) AS prev_touch_campaign,
    COALESCE(pv.staff,
        CASE
            WHEN pv.touch_id IS NULL THEN 'No Earlier Touch'::text
            ELSE '(Blank)'::text
        END) AS prev_touch_staff
   FROM analytics.mv_payer_new p
     LEFT JOIN x ON x.user_id = p.user_id
     LEFT JOIN pv ON pv.user_id = p.user_id;
CREATE UNIQUE INDEX mv_payer_first_touch_new_pk ON analytics.mv_payer_first_touch_new USING btree (user_id);
ANALYZE analytics.mv_payer_first_touch_new;
@@
-- check the new tables before the swap: same users as the live table
select (select count(*) from analytics.mv_payer)::int as old_rows, (select count(*) from analytics.mv_payer_new)::int as new_rows,
       (select count(*) from analytics.mv_payer_first_touch_new)::int as new_first_rows,
       (select count(*) from analytics.mv_payer where last_touch_point = 'Eduport App')::int as old_app_last,
       (select count(*) from analytics.mv_payer_new where last_touch_point = 'Eduport App')::int as new_app_last,
       (select count(*) from analytics.mv_payer where last_touch_id is null)::int as old_no_touch,
       (select count(*) from analytics.mv_payer_new where last_touch_id is null)::int as new_no_touch
@@
-- swap (one transaction, a fraction of a second): the dependent first-touch table goes first
DROP MATERIALIZED VIEW analytics.mv_payer_first_touch;
DROP MATERIALIZED VIEW analytics.mv_payer;
ALTER MATERIALIZED VIEW analytics.mv_payer_new RENAME TO mv_payer;
ALTER MATERIALIZED VIEW analytics.mv_payer_first_touch_new RENAME TO mv_payer_first_touch;
ALTER INDEX analytics.mv_payer_new_pk RENAME TO mv_payer_pk;
ALTER INDEX analytics.mv_payer_new_last_pay RENAME TO mv_payer_last_pay;
ALTER INDEX analytics.mv_payer_new_phone RENAME TO mv_payer_phone;
ALTER INDEX analytics.mv_payer_first_touch_new_pk RENAME TO mv_payer_first_touch_pk;
GRANT SELECT ON analytics.mv_payer, analytics.mv_payer_first_touch TO metabase_ro;
