const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
const num2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export const fmtInt = (v: number | null | undefined) => (v == null ? '–' : num.format(v));
export const fmt1 = (v: number | null | undefined) => (v == null ? '–' : num1.format(v));
export const fmt2 = (v: number | null | undefined) => (v == null ? '–' : num2.format(v));
export const fmtPct = (v: number | null | undefined, d = 1) => (v == null ? '–' : `${v.toFixed(d)}%`);
export const fmtPP = (v: number | null | undefined) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)} pp`);
export function fmtINR(v: number | null | undefined): string {
  if (v == null) return '–';
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${inr.format(v)}`;
}
export const fmtINRfull = (v: number | null | undefined) => (v == null ? '–' : `₹${inr.format(v)}`);
export function fmtHours(h: number | null | undefined): string {
  if (h == null) return '–';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}
export function fmtCompact(v: number | null | undefined): string {
  if (v == null) return '–';
  const a = Math.abs(v);
  if (a >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return num.format(v);
}
export const fmtDateShort = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '–');
export const fmtDateTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '–');
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** relative delta for KPI cards: returns {text, dir} */
export function delta(cur: number | null | undefined, prev: number | null | undefined, kind: 'pct' | 'pp' | 'num' = 'pct'): { text: string; dir: 'up' | 'down' | 'flat' } | null {
  if (cur == null || prev == null) return null;
  if (kind === 'pp') { const d = cur - prev; return { text: fmtPP(d), dir: d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat' }; }
  if (kind === 'num') { const d = cur - prev; return { text: `${d > 0 ? '+' : ''}${fmt1(d)}`, dir: d > 0 ? 'up' : d < 0 ? 'down' : 'flat' }; }
  if (!prev) return null;
  const d = ((cur - prev) / prev) * 100;
  return { text: `${d > 0 ? '+' : ''}${d.toFixed(1)}%`, dir: d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat' };
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const esc = (v: unknown) => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
export function downloadText(name: string, text: string, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Title Case for headings, labels and legends (user, 2026-11-27): every word starts with a capital except the small joining
 *  words (a, an, and, of, to ...) in the middle. Words that already hold a capital or a digit (LM, UJRA, 2h, iOS) are kept. */
const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'nor', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'vs', 'via', 'as', 'with', 'from']);
export function titleCase(s: string): string {
  if (!s) return s;
  let first = true;
  return s.replace(/[A-Za-z][A-Za-z']*/g, (w, at: number) => {
    const prev = s[at - 1] ?? ' ';
    const isFirst = first && !s.slice(0, at).trim(); first = false;
    if (/[A-Z0-9]/.test(w) || /[A-Za-z0-9]/.test(prev)) return w;   // already capitalised, or the tail of a word like "2h"
    const after = s.slice(Math.max(0, at - 2), at);
    if (!isFirst && SMALL.has(w) && !/[(·:→]\s?$/.test(after)) return w;
    return w[0]!.toUpperCase() + w.slice(1);
  });
}
/** Subtitles, captions and notes: sentence case, i.e. only the first letter is raised. */
export const capFirst = (s: string) => (s ? s.replace(/^(\s*)([a-z])/, (_m, p: string, c: string) => p + c.toUpperCase()) : s);
