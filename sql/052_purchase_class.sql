-- 052 (2026-11-23): the class of a PURCHASED course, named like the lead's Class Group (analytics.class_group, sql/050), so a course and a
-- lead compare on the same names: "Class 10 Board" / "Class 10 CBSE", "Class 11 Science" / "Class 11 Science CBSE", "Repeater" ...
-- Input = the batch's grade (core_grade.title) and course title (core_syllabusstructure.title), both on app.core_batch.
--   class number : the grade's number; the title's only when the grade is not a class (Foundation Courses, GCC, One-on-One, Franchise ...)
--                  SSLC -> 10, Plus One -> 11, Plus Two -> 12, LSS -> 4, USS -> 7, NMMS -> 8
--   Class 7-10   : "CBSE" in the title, or a Foundation Courses grade (all CBSE in production's Board field) -> CBSE; English / Malayalam
--                  medium, SSLC, Kerala Board, USS, NMMS, Rapid Revision -> Board; otherwise the plain class
--   Class 11/12  : stream from the grade (Class 12 Say and Improvement and the rest from the title); "CBSE" in the title -> "<stream> CBSE".
--                  Plus One Improvement courses sit under Class 12 grades (taken by Plus Two students) -> Class 12
--   Crash grade  : CUET crash -> Class 12 <stream> (CUET leads are Class 12 too); NEET -> NEET Crash; KEAM / JEE -> KEAM/JEE Crash
--   Repeater     : Repeater and Former Programs grades, and repeater / Restart JEE / JEE Advanced / NTS titles
--   Other        : workshops, talent hunt, sample courses, anything without a class
-- Tested 23 Nov 2026 on all 327 grade x course titles: every paid course lands in a lead-style name. Ujra bookings are named by the caller.
CREATE OR REPLACE FUNCTION analytics.purchase_class(grade text, course text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN x.t ~ 'excel|talent hunt|sample course|scholarship' OR x.g IN ('Training Module', 'Scholarship Exams') THEN 'Other'
    WHEN x.g IN ('Repeater', 'Former Programs') OR x.t ~ 'repeater|restart jee|jee \(?advanced|nts \(neet test' THEN 'Repeater'
    WHEN x.g = 'Crash' AND x.t ~ 'cuet' THEN 'Class 12 ' || coalesce(x.stream, '(no stream)')
    WHEN x.g = 'Crash' AND x.t ~ 'neet' THEN 'NEET Crash'
    WHEN x.g = 'Crash' THEN 'KEAM/JEE Crash'
    WHEN x.n BETWEEN 4 AND 6 THEN 'Class ' || x.n
    WHEN x.n BETWEEN 7 AND 10 AND (x.t ~ 'cbse' OR x.g = 'Foundation Courses') THEN 'Class ' || x.n || ' CBSE'
    WHEN x.n BETWEEN 7 AND 10 AND x.t ~ 'english|malayalam|sslc|kerala|uss|lss|nmms|board|rapid revision' THEN 'Class ' || x.n || ' Board'
    WHEN x.n BETWEEN 7 AND 10 THEN 'Class ' || x.n
    WHEN x.n IN (11, 12) AND x.t ~ 'cbse' THEN 'Class ' || x.n || ' ' || coalesce(x.stream, 'Science') || ' CBSE'
    WHEN x.n IN (11, 12) THEN 'Class ' || x.n || ' ' || coalesce(x.stream, '(no stream)')
    ELSE 'Other' END
  FROM (
    SELECT y.g, y.t,
           coalesce(substring(y.g from '^Class (\d+)')::int, substring(y.t from 'class\s*(\d+)')::int,
             CASE WHEN y.t ~ 'sslc' THEN 10 WHEN y.t ~ 'plus one|\+1' THEN 11 WHEN y.t ~ 'plus two|\+2' THEN 12
                  WHEN y.t ~ 'lss' THEN 4 WHEN y.t ~ 'uss' THEN 7 WHEN y.t ~ 'nmms' THEN 8 END) AS n,
           coalesce(substring(y.g from '(Science|Commerce|Humanities)'),
             CASE WHEN y.t ~ 'commerce' THEN 'Commerce' WHEN y.t ~ 'humanities' THEN 'Humanities'
                  WHEN y.t ~ 'science|neet|jee|keam|cbse' THEN 'Science' END) AS stream
    FROM (SELECT grade AS g, lower(coalesce(course, '')) AS t) y) x
$fn$;
@@
-- the lookup table of 051, now with the full purchased class (base_class kept for the base comparisons)
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_lead_class_pay;
CREATE MATERIALIZED VIEW analytics.mv_lead_class_pay AS
WITH b AS (
  SELECT cb.id, analytics.purchase_class(cb.grade_title, cb.course_title) AS purchased_class
  FROM app.core_batch cb WHERE cb.grade_title IS NOT NULL OR cb.course_title IS NOT NULL)
SELECT DISTINCT ll.lead_id, b.purchased_class, COALESCE(substring(b.purchased_class from '^Class [0-9]+'), b.purchased_class) AS base_class, p.payment_date
FROM app.home_payment p
JOIN b ON b.id = COALESCE(p.enrollment_batch_id, p.batch_id)
JOIN analytics.mv_user_phone up ON up.user_id = p.user_id
JOIN analytics.mv_lead_lite ll ON ll.phone_key = up.phone_key AND ll.phone_valid
WHERE p.payment_method = 0 AND p.deleted = false AND p.is_success = true AND p.payment_success = true AND p.payment_date IS NOT NULL
WITH DATA;
CREATE UNIQUE INDEX mv_lead_class_pay_pk ON analytics.mv_lead_class_pay (lead_id, purchased_class, payment_date);
CREATE INDEX mv_lead_class_pay_class ON analytics.mv_lead_class_pay (purchased_class, payment_date, lead_id);
ANALYZE analytics.mv_lead_class_pay;
@@
SELECT purchased_class, count(DISTINCT lead_id) AS leads, count(*) AS rows_ FROM analytics.mv_lead_class_pay GROUP BY 1 ORDER BY 1
