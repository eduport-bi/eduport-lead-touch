-- 050 (2026-11-12): board split in the Class filter and the class cards.
--   Class 7 / 8 / 9 / 10 split CBSE vs Board, read from the lead's Class field: "... CBSE" -> CBSE; the state syllabus in either medium
--     ("... MALAYALAM", "... ENGLISH", SSLC) -> Board (CLASS - 8 MALAYALAM and CLASS - 8 ENGLISH -> Class 8 Board, SSLC ENGLISH -> Class 10 Board,
--     Class 10 CBSE -> Class 10 CBSE); no board in the value -> Class 7 / 8 / 9 (SSLC itself is the state board exam, so Class 10 is always Board or CBSE).
--   Class 11 / 12 keep the stream split of sql/042 and add CBSE only where the value says so:
--     PLUSONE SCIENCE CBSE -> Class 11 Science CBSE, PLUS TWO SCIENCE CBSE -> Class 12 Science CBSE, PLUSONE CBSE -> Class 11 CBSE.
--   Classes 4-6 and the named programmes are unchanged.
-- class_group is stored in mv_lead_lite / mv_touch_flat / mv_payer: run analytics.refresh_all() (objects = refresh_only) right after this.
CREATE OR REPLACE FUNCTION analytics.class_group(p text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  n  text;
  m  text[];
  s  text;
  b  text;
  k_completed constant text := 'Plus Two Completed';
  k_unknown   constant text := 'Unknown';
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN k_unknown; END IF;
  n := btrim(regexp_replace(upper(p), '[^A-Z0-9]+', ' ', 'g'));
  IF n IN ('NOT UPDATED', 'NA', 'N A', 'NONE', 'NULL') THEN RETURN k_unknown; END IF;

  IF n ~ '(PLUS ?TWO|PLUS ?2|12(TH)?|XII) COMPLETED' OR n ~ '^COMPLETED' THEN RETURN k_completed; END IF;
  IF n ~ 'REPEATER' OR n ~ 'REPEAT(ER)?S?$' OR n ~ 'DROPPER' THEN RETURN 'Repeater'; END IF;

  -- named programmes kept as their own groups
  IF n ~ 'NMMS' THEN RETURN 'NMMS'; END IF;
  IF n ~ 'CRASH' THEN
    IF n ~ 'NEET' THEN RETURN 'NEET Crash'; END IF;
    RETURN 'KEAM/JEE Crash';
  END IF;

  -- stream of a Class 11 / 12 lead, and the board of a Class 7-12 lead (CBSE, or Board = state syllabus in Malayalam or English medium), from the same field
  s := CASE WHEN n ~ 'SCIENCE' THEN ' Science' WHEN n ~ 'COMMERCE' THEN ' Commerce' WHEN n ~ 'HUMANIT|(^|\s)ARTS(\s|$)' THEN ' Humanities' ELSE ' (no stream)' END;
  b := CASE WHEN n ~ 'CBSE' THEN ' CBSE' WHEN n ~ 'MALAYALAM|ENGLISH|(^|\s)SSLC(\s|$)' THEN ' Board' ELSE '' END;

  IF n ~ '(^|\s)CUET(\s|$)' THEN RETURN 'Class 12' || s; END IF;
  IF n ~ '(^|\s)(PLUS ?TWO|PLUS ?2|CLASS ?12|12 ?TH|STD ?12|XII|HSE 2|SECOND YEAR)(\s|$)' THEN
    RETURN 'Class 12' || CASE WHEN b = ' CBSE' THEN replace(s, ' (no stream)', '') || b ELSE s END;
  END IF;
  IF n ~ '(^|\s)(PLUS ?ONE|PLUS ?1|CLASS ?11|11 ?TH|STD ?11|XI|HSE 1|FIRST YEAR)(\s|$)' THEN
    RETURN 'Class 11' || CASE WHEN b = ' CBSE' THEN replace(s, ' (no stream)', '') || b ELSE s END;
  END IF;
  IF n ~ '(^|\s)(SSLC|CLASS ?10|10 ?TH|STD ?10|X|TENTH)(\s|$)' THEN RETURN 'Class 10' || b; END IF;

  m := regexp_match(n, '(^|\s)(?:CLASS|STD|STANDARD|GRADE)?\s*([1-9])\s*(?:TH|ST|ND|RD)?(?:\s|$)');
  IF m IS NOT NULL THEN
    IF m[2]::int BETWEEN 7 AND 9 THEN RETURN 'Class ' || m[2] || b; END IF;
    IF m[2]::int BETWEEN 4 AND 6 THEN RETURN 'Class ' || m[2]; END IF;
    RETURN 'Other';
  END IF;

  RETURN 'Other';
END $$;
@@
CREATE OR REPLACE FUNCTION analytics.class_group_order(g text)
RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE g
    WHEN 'Class 4' THEN 40  WHEN 'Class 5' THEN 50  WHEN 'Class 6' THEN 60
    WHEN 'Class 7 Board'  THEN 70  WHEN 'Class 7 CBSE'  THEN 71  WHEN 'Class 7'  THEN 72
    WHEN 'Class 8 Board'  THEN 80  WHEN 'Class 8 CBSE'  THEN 81  WHEN 'Class 8'  THEN 82
    WHEN 'Class 9 Board'  THEN 90  WHEN 'Class 9 CBSE'  THEN 91  WHEN 'Class 9'  THEN 92
    WHEN 'Class 10 Board' THEN 100 WHEN 'Class 10 CBSE' THEN 101 WHEN 'Class 10' THEN 102
    WHEN 'Class 11 Science' THEN 110 WHEN 'Class 11 Science CBSE' THEN 111 WHEN 'Class 11 Commerce' THEN 112 WHEN 'Class 11 Humanities' THEN 113
    WHEN 'Class 11 (no stream)' THEN 114 WHEN 'Class 11 CBSE' THEN 115
    WHEN 'Class 12 Science' THEN 120 WHEN 'Class 12 Science CBSE' THEN 121 WHEN 'Class 12 Commerce' THEN 122 WHEN 'Class 12 Humanities' THEN 123
    WHEN 'Class 12 (no stream)' THEN 124 WHEN 'Class 12 CBSE' THEN 125
    WHEN 'Plus Two Completed' THEN 190 WHEN 'Repeater' THEN 200
    WHEN 'KEAM/JEE Crash' THEN 210 WHEN 'NEET Crash' THEN 220 WHEN 'NMMS' THEN 230
    WHEN 'Other' THEN 980 WHEN 'Unknown' THEN 990 ELSE 970 END
$$;
@@
-- self-test brought up to date (the 002 version still expected the pre-018 groups): SELECT * FROM analytics.class_group_selftest() WHERE NOT ok;
CREATE OR REPLACE FUNCTION analytics.class_group_selftest()
RETURNS TABLE(raw text, expected text, got text, ok boolean)
LANGUAGE sql STABLE AS $$
  SELECT raw, expected, analytics.class_group(raw), analytics.class_group(raw) IS NOT DISTINCT FROM expected
  FROM (VALUES
    ('CLASS - 4','Class 4'), ('Class 4','Class 4'), ('class-4','Class 4'), ('4th std','Class 4'),
    ('CLASS - 6','Class 6'),
    ('CLASS - 7 CBSE','Class 7 CBSE'), ('CLASS - 7 MALAYALAM','Class 7 Board'), ('CLASS - 7 ENGLISH','Class 7 Board'), ('Class 7','Class 7'),
    ('CLASS - 8 CBSE','Class 8 CBSE'), ('CLASS - 8 MALAYALAM','Class 8 Board'), ('CLASS - 8 ENGLISH','Class 8 Board'), ('Class 8','Class 8'),
    ('CLASS - 9 CBSE','Class 9 CBSE'), ('CLASS - 9 MALAYALAM','Class 9 Board'), ('CLASS - 9 ENGLISH','Class 9 Board'),
    ('Class 10 CBSE','Class 10 CBSE'), ('SSLC MALAYALAM','Class 10 Board'), ('SSLC ENGLISH','Class 10 Board'), ('SSLC','Class 10 Board'), ('Class 10','Class 10'),
    ('PLUSONE','Class 11 (no stream)'), ('PLUSONE SCIENCE','Class 11 Science'), ('PLUSONE SCIENCE CBSE','Class 11 Science CBSE'),
    ('PLUSONE CBSE','Class 11 CBSE'), ('Plus One Commerce','Class 11 Commerce'), ('PLUSONE HUMANITIES','Class 11 Humanities'),
    ('PLUS TWO','Class 12 (no stream)'), ('PLUS TWO SCIENCE','Class 12 Science'), ('PLUS TWO SCIENCE CBSE','Class 12 Science CBSE'),
    ('PLUS TWO HUMANITIES','Class 12 Humanities'), ('plus-two science','Class 12 Science'),
    ('CUET','Class 12 (no stream)'), ('CUET - Commerce','Class 12 Commerce'),
    ('Plus Two Completed','Plus Two Completed'), ('Plus Two Completed (Science) on 2026','Plus Two Completed'),
    ('Repeater','Repeater'), ('NEET Repeater_26','Repeater'), ('Re-Repeater NEET','Repeater'), ('Repeater JEE (Online)','Repeater'),
    ('KEAM/JEE Crash','KEAM/JEE Crash'), ('NEET CRASH (Online)','NEET Crash'), ('NMMS','NMMS'), ('CLASS - 2','Other'),
    (NULL,'Unknown'), ('','Unknown'), ('Not updated','Unknown')
  ) v(raw, expected)
$$;
