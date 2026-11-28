-- 058 (2026-11-28): covering indexes for the per-lead lookups the dashboard does thousands of times per view, so they are answered
-- from the index alone instead of one random table page per lead.
--   * Overview IC status / Interested course cards: every lead of the selection -> its interested courses (status, course).
--     Was 1.8 s for a 30-day view: 13k index probes, each reading a random page of interested_course__c.
--   * Turnaround (Overview + Converted), Avg touches before conversion: the latest / pre-payment touches of one lead.
-- CREATE INDEX blocks writes to the table while it builds (seconds), never reads. Run when the sync is not running.
-- Nothing is deleted or changed.

CREATE INDEX IF NOT EXISTS interested_course_lead_status ON salesforce.interested_course__c (lead_master__c) INCLUDE (status__c, course__c) WHERE isdeleted = false;
@@
CREATE INDEX IF NOT EXISTS mv_touch_flat_lead_date ON analytics.mv_touch_flat (lead_id, touch_date) INCLUDE (is_pre_conversion);
@@
-- index-only scans need the visibility map; the sync's upserts clear it, autovacuum and the nightly VACUUM of the views set it again
VACUUM (ANALYZE) salesforce.interested_course__c;
