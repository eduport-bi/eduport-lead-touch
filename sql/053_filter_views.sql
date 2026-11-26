-- 053 (2026-11-26): named filter views, like Google Sheets filter views. Each dashboard user keeps any number of named views
-- (the filter bar's URL query string, same format as app_auth.user_filters); a view can be shared with the team (read-only for others).
-- GET / POST / PUT / DELETE /api/auth/views. The single "Save filter" default (user_filters) stays as it is.
CREATE TABLE IF NOT EXISTS app_auth.filter_views (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,                 -- owner (lower-case e-mail, as in user_filters)
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  query       text NOT NULL CHECK (length(query) <= 4000),
  shared      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS filter_views_owner_name ON app_auth.filter_views (email, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS filter_views_shared ON app_auth.filter_views (shared) WHERE shared;
@@
SELECT count(*) AS views FROM app_auth.filter_views
