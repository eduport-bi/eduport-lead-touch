-- 059 (2026-11-28): Callyzer call log, SALES ONLY (user rule 2026-11-28: "only take sales calls into consideration - we don't want the rest").
-- The nightly sync (sync/src/callyzer.ts) asks Callyzer only for the calls of staff whose department is Sales today; nobody else's calls
-- reach this database. Callyzer keeps no department history: a call counts under the caller's department on the day it was pulled.
-- Rows are kept by call_id, so a re-pull never doubles a call. The repository holds this definition only, never data.

CREATE SCHEMA IF NOT EXISTS callyzer;

-- Sales staff as Callyzer lists them today (employee_code = EP1234, the Salesforce User EmployeeNumber)
CREATE TABLE IF NOT EXISTS callyzer.employees (
  employee_code   text PRIMARY KEY,
  name            text,
  company_email   text,
  phone           text,
  role            text,          -- SUPERADMIN / ADMIN / MANAGER / TL / BDE
  department      text,
  reports_to_code text,
  status          text,          -- PENDING / ACTIVE / REMOVED
  is_remote       boolean,
  accepted_at     timestamptz,
  removed_at      timestamptz,
  created_at      timestamptz,
  synced_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS callyzer.calls (
  call_id        text PRIMARY KEY,
  employee_code  text NOT NULL,
  number_last10  text,           -- last ten digits = analytics.mv_lead_lite.phone_key
  number_e164    text,
  started_at     timestamptz NOT NULL,
  duration_sec   integer NOT NULL DEFAULT 0,   -- connected seconds
  call_type      text NOT NULL,  -- OUTGOING / INCOMING / MISSED / REJECTED / BLOCKED
  raw_call_type  integer,
  is_connected   boolean NOT NULL DEFAULT false,
  has_recording  boolean,
  received_at    timestamptz,
  synced_at      timestamptz NOT NULL DEFAULT now()
);
-- by lead number and time (the lead's calls after its touch), by caller and time (an owner's calls), by time (a date range)
CREATE INDEX IF NOT EXISTS calls_number_time ON callyzer.calls (number_last10, started_at);
CREATE INDEX IF NOT EXISTS calls_employee_time ON callyzer.calls (employee_code, started_at);
CREATE INDEX IF NOT EXISTS calls_time ON callyzer.calls (started_at);

-- the dashboard connects as the owner role; Metabase reads like the analytics views (metabase_ro)
GRANT USAGE ON SCHEMA callyzer TO metabase_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA callyzer TO metabase_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA callyzer GRANT SELECT ON TABLES TO metabase_ro;
