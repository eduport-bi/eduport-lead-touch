// Response shapes of the Worker API (kept in sync with api/src/routes/*)
export interface Envelope<T> { data: T; meta: { period: Period; previous: Period | null; basis: string; tookMs: number }; /** set by apiFetch: the server sent the last answer of an older data version (a refresh follows) */ stale?: boolean }
export interface Period { from: string; to: string }

export interface Definition { key: string; title: string; plain: string; sql: string; deviation?: string }

export interface Meta {
  user: { email: string; role: 'admin' | 'analyst' | 'viewer'; name?: string };
  version: string;
  dataAsOf: { refreshed_at: string | null; salesforce_as_of: string | null; last_sync_run_at: string | null; lead_master_synced_at: string | null; lead_rows: number; touch_rows: number };
  syncState: { object_name: string; last_modstamp: string | null; last_run_at: string | null; last_run_rows: number | null; last_error: string | null }[];
  lastRefresh: { view_name: string; finished_at: string | null; ok: boolean | null; row_count: number | null; error: string | null }[];
  dims: { lead: Record<string, string>; touch: Record<string, string> };
  definitions: Definition[];
}

export interface KpiSet {
  leads: number; converted: number; converted_new: number; pre_existing: number; revenue: number; refunds: number;
  first_touch_conversions: number; last_touch_conversions: number; unattributed: number;
  avg_touches_to_convert: number | null; median_touches_to_convert: number | null; p90_touches_to_convert: number | null;
  avg_days_to_convert: number | null; median_days_to_convert: number | null;
  contacted: number; median_response_hours: number | null;
  touches: number; valid_touches: number; touched_leads: number;
  touches_per_lead: number | null; conv_rate: number | null; revenue_per_lead: number | null; contact_rate: number | null;
  touch_buckets: { bucket: string; leads: number; converted: number }[];
}
export interface KpisResponse { current: KpiSet; previous: KpiSet | null }

export interface TrendRow { d: string; leads: number; converted: number; revenue: number; touches: number }
export interface TrendResponse { grain: string; source: string; rows: TrendRow[]; previous: TrendRow[] | null }

export interface BreakdownRow {
  key: string; key2?: string | null; leads: number; converted: number; conv_rate: number | null; revenue: number; revenue_per_lead: number | null;
  touches: number; avg_touches: number | null; contacted: number; conv_first?: number; conv_last?: number; conv_linear?: number;
  previous?: BreakdownRow | null;
}
export interface BreakdownResponse { dim: string; dim2: string | null; mode: 'lead' | 'touch'; rows: BreakdownRow[]; total: BreakdownRow; previousTotal: BreakdownRow | null }

export interface FilterOption { value: string; leads: number; converted: number }
export interface FiltersResponse { dim: string; options: FilterOption[] }

export interface AttributionRow {
  key: string; touches: number; leads: number; first_touch: number; last_touch: number; linear: number; position: number;
  rev_first: number; rev_last: number; rev_linear: number; rev_position: number; diff_last_vs_linear: number; share_last: number | null; share_linear: number | null;
}
export interface AttributionResponse {
  dim: string; rows: AttributionRow[]; totals: { first_touch: number; last_touch: number; linear: number; position: number };
  unattributed: { converted: number; unattributed: number; unattributed_revenue: number; pre_existing: number; never_touched: number; touched_after_only: number };
  note: string;
}

export interface CurvePoint { bucket: string; leads: number; converted: number; conv_rate: number | null; revenue: number; marginal_lift_pp: number | null }
export interface TouchCurveResponse { by: string | null; groups: { group: string; total_leads: number; points: CurvePoint[]; optimal_touches: string | null }[]; rule: string }
export interface TouchGapsResponse { buckets: { bucket: string; touches: number; leads: number; converted_leads: number; median_hours: number | null; conv_rate: number | null }[]; overall: { median_hours: number | null; avg_hours: number | null; p90_hours: number | null; gaps: number } }
export interface HeatmapResponse { rows: { dow: number; hour: number; touches: number; converted_touches: number; leads: number }[]; tz: string }
export interface TransitionsResponse { rows: { src: string; dst: string; leads: number; converted: number; revenue: number; conv_rate: number | null; same: boolean }[] }
export interface StaleLeadsResponse { days: number; page: number; limit: number; total: number; never_touched: number; rows: Record<string, unknown>[]; by_owner: { owner_name: string; n: number }[] }

export interface FunnelResponse {
  stages: { stage: string; leads: number; converted: number; revenue: number; avg_touches: number | null; open_leads: number; conv_rate: number | null }[];
  ic_status: { status: string; ics: number; leads: number; enrolled: number; fees_offered: number; converted_leads: number }[];
  discount_leakage: { leads: number; offered: number; realized: number; leads_with_offer: number; leakage: number; leakage_pct: number | null };
  ic_count: { ic_bucket: string; leads: number; converted: number; conv_rate: number | null }[];
  lm_reasons: { reason: string; leads: number; converted: number }[];
  task_reasons: { reason: string; leads: number; converted: number }[];
  time_in_stage: { stage: string; leads: number; median_days: number | null; avg_days: number | null }[];
  notes: string[];
}

export interface CohortRow {
  cohort: string; leads: number; c7: number; c14: number; c30: number; c60: number; c90: number; c_all: number; revenue: number; age_days: number;
  r7: number | null; r14: number | null; r30: number | null; r60: number | null; r90: number | null; r_all: number | null;
  mature: { d7: boolean; d14: boolean; d30: boolean; d60: boolean; d90: boolean }; first_week_share: number | null;
}
export interface CohortsResponse { grain: string; rows: CohortRow[]; days_to_convert: { bucket: string; ord: number; leads: number; revenue: number }[]; first_week_share: { converted: number; within_7: number; within_30: number; share_7: number | null; share_30: number | null; note: string } }

export interface OwnerRow {
  owner_name: string; owner_id: string | null; leads: number; contacted: number; touches: number; avg_touches: number | null; converted: number; revenue: number;
  median_response_hours: number | null; call_attempts: number; calls_connected: number; avg_call_seconds: number | null; leads_with_calls: number; open_leads: number; stale_7d: number;
  contact_rate: number | null; conv_rate: number | null; revenue_per_lead: number | null; connect_rate: number | null; calls_per_lead: number | null;
}
export interface StaffRow { staff: string; touches: number; leads: number; conv_last: number; conv_linear: number; revenue_linear: number; converted_leads: number; touches_per_lead: number | null; conv_rate: number | null }
export interface TeamResponse { owners: OwnerRow[]; staff: StaffRow[]; fairness_note: string }

export type LeadRow = Record<string, unknown> & { lead_id: string; lead_name: string };
export interface LeadsResponse { page: number; limit: number; total: number; rows: LeadRow[]; masked: boolean }
export interface LeadDetail { lead: LeadRow; touches: Record<string, unknown>[]; ics: Record<string, unknown>[]; payments: Record<string, unknown>[]; calls: Record<string, unknown>[]; call_summary: Record<string, unknown> | null; siblings: Record<string, unknown>[]; masked: boolean }

export interface DqCheck { check_key: string; label: string; bad_rows: number; total_rows: number; pct: number | null }
export interface DqResponse { checks: DqCheck[]; note: string }
export interface DqRowsResponse { check: string; page: number; limit: number; total: number; rows: Record<string, unknown>[] }

export interface MoverRow { dim: string; key: string; leads: number; prev_leads: number; converted: number; prev_converted: number; rate: number; prev_rate: number; delta_pp: number; impact: number }
export interface MoversResponse { previous: Period; min_leads: number; up: MoverRow[]; down: MoverRow[] }
