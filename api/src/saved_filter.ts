import { LIST_KEYS, todayIST } from './filters';

/**
 * A saved filter set (app_auth.user_filters.query: the filter bar's URL query string, the web app's format with relative presets)
 * turned into the query the pages send to the API for TODAY - the same mapping as the web app's parse() + toApiParams()
 * (web/src/lib/filters.ts), so the cache entry the warm-up writes is the one the user's first visit reads.
 * Returns null when the string cannot be read.
 */
export function savedQueryToApi(query: string, today = todayIST()): Record<string, string> | null {
  let sp: URLSearchParams;
  try { sp = new URLSearchParams(query.replace(/^\?/, '')); } catch { return null; }
  const preset = sp.get('preset') ?? '30d';
  const [df, dt] = presetRange(preset, today);
  const day = (v: string | null, def: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : def);
  const from = preset === 'custom' ? day(sp.get('from'), df) : df;
  const to = preset === 'custom' ? day(sp.get('to'), dt) : dt;
  const o: Record<string, string> = { from, to, basis: sp.get('basis') === 'touch' ? 'touch' : 'created', compare: sp.get('compare') === 'previous' ? 'previous' : 'none' };
  if (sp.get('pay') === '1') { o.pay = '1'; o.pfrom = day(sp.get('pfrom'), from); o.pto = day(sp.get('pto'), to); }
  if (sp.get('converted') === '1') o.converted = '1';
  if (sp.get('dups') === '1') o.dups = '1';
  const paid = sp.get('paid');
  if (paid === 'paid' || paid === 'organic') o.paid = paid;
  // list values travel exactly as the filter bar stores them (one encodeURIComponent per value, comma separated): the web app decodes
  // and re-encodes them on the way to the API, which is the identity for that encoding
  for (const k of LIST_KEYS) { const v = sp.get(k); if (v && v.split(',').some(Boolean)) o[k] = v.split(',').filter(Boolean).join(','); }
  for (const k of ['hot', 'supreme_hot', 'relogged', 'repeat', 'pre_existing']) { const v = sp.get(k); if (v === '1' || v === '0') o[k] = v; }
  return o;
}

// ---------------------------------------------------------------- presets (IST calendar days, as web/src/lib/filters.ts PRESETS)
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };

export function presetRange(preset: string, today: string): [string, string] {
  const t = toDate(today);
  switch (preset) {
    case 'today': return [today, today];
    case 'yesterday': { const y = addDays(today, -1); return [y, y]; }
    // Last N days end yesterday, today left out (as Metabase's "Previous N days", 2026-11-27)
    case '7d': return [addDays(today, -7), addDays(today, -1)];
    case '90d': return [addDays(today, -90), addDays(today, -1)];
    case 'mtd': return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), today];
    case 'lastm': return [fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1))), fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0)))];
    case 'fy': { const y = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1; return [fmt(new Date(Date.UTC(y, 3, 1))), today]; }
    case '30d': return [addDays(today, -30), addDays(today, -1)];
    case 'custom': default: return [addDays(today, -29), today];
  }
}
