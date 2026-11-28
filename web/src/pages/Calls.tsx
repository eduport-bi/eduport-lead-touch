import { useMemo, useState } from 'react';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Col } from '../components/DataTable';
import { KpiTile } from '../components/KpiTile';
import { DailyLines, HBars, Heatmap } from '../charts';
import { CardSearch, Icon, Note, PageHeader, Segmented } from '../components/ui';
import { useCallFilters } from '../lib/callFilters';
import { useFilters } from '../lib/filters';
import { fmtInt, fmtPct } from '../lib/format';

/**
 * DRAFT (2026-11-28, second pass): the planned Lead Call Analytics page, built from the app's own cards.
 * Every number is SAMPLE DATA - nothing comes from Callyzer or the database yet. Preview only, not deployed.
 * Changes asked on 2026-11-28: a Call date basis; enough effort = connected, or 3+ calls tried; BDE scorecard removed;
 * touch point › campaign and medium › campaign views; talk time by lead owner over N days; a comparison table;
 * a click on any bar, row, cell or day filters every card on the page.
 */

// ---------- sample data helpers
const rnd = (i: number, k: number) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** one row of every measure the page knows; the comparison table picks from these */
type MRow = {
  key: string; leads: number; called_pct: number; calls: number; calls_per_lead: number; connected_pct: number; talk_h: number; avg_talk_min: number;
  effort_pct: number; converted: number; conv_pct: number; calls_before: number; first_call_h: number; missed: number; rejected_pct: number; children?: MRow[];
};
const gen = (key: string, size: number): MRow => {
  const i = hash(key); const leads = Math.max(20, Math.round(size * (0.6 + rnd(i, 1) * 0.8)));
  const called = 45 + rnd(i, 2) * 50, cpl = 1.5 + rnd(i, 3) * 4, conn = 25 + rnd(i, 4) * 35, conv = 1 + rnd(i, 5) * 14;
  const calls = Math.round(leads * (called / 100) * cpl);
  return {
    key, leads, called_pct: Math.round(called), calls, calls_per_lead: r1(cpl), connected_pct: Math.round(conn), talk_h: r1((calls * conn / 100) * (1.2 + rnd(i, 6) * 3) / 60),
    avg_talk_min: r1(1.2 + rnd(i, 6) * 3), effort_pct: Math.round(Math.min(95, called * 0.8 + rnd(i, 7) * 15)), converted: Math.round(leads * conv / 100), conv_pct: r1(conv),
    calls_before: r1(2 + rnd(i, 8) * 4), first_call_h: r1(0.5 + rnd(i, 9) * 20), missed: Math.round(calls * (0.03 + rnd(i, 10) * 0.08)), rejected_pct: r1(2 + rnd(i, 11) * 12),
  };
};

const TOUCH = ['App Installed', 'Fb Ad', 'Whatsapp Community', 'Tally.so Form', 'Google Form', 'Inbound Phone Call'];
const MEDIUM = ['Meta', 'Organic', 'WhatsApp', 'Google', 'Referral'];
const SOURCE = ['App Installed', 'Fb Ad', 'Whatsapp Community', 'Tally.so Form', 'Google Form', 'Inbound Phone Call', 'Website'];
const CLASSES = ['Class 8', 'Class 9', 'Class 10', 'Plus One Science', 'Plus Two Science', 'Plus One Commerce', 'Repeater'];
const CAMPS = ['Plus One Science · Nov', 'Class 10 Board Crash', 'NEET Repeater 2027', 'Class 9 Foundation', 'Plus Two Commerce · Nov'];
const OWNERS = Array.from({ length: 254 }, (_, i) => `BDE ${String(i + 1).padStart(3, '0')}`);
const WEEKS = ['W41 · 5 Oct', 'W42 · 12 Oct', 'W43 · 19 Oct', 'W44 · 26 Oct', 'W45 · 2 Nov', 'W46 · 9 Nov', 'W47 · 16 Nov', 'W48 · 23 Nov'];
const MONTHS = ['Oct 2026', 'Nov 2026'];
const DATES = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 29 + i)).toISOString().slice(0, 10));

const withCamps = (parents: string[], size: number) => parents.map((p) => ({ ...gen(p, size), children: CAMPS.slice(0, 2 + (hash(p) % 4)).map((c) => gen(`${p}|${c}`, size / 4)) }));
const DIM_ROWS: Record<string, () => MRow[]> = {
  campaign: () => CAMPS.map((c) => gen(c, 1500)), touch_point: () => TOUCH.map((t) => gen(t, 3500)), medium: () => MEDIUM.map((m) => gen(m, 4000)),
  lead_source: () => SOURCE.map((s) => gen(s, 3000)), class: () => CLASSES.map((c) => gen(c, 3000)), owner: () => OWNERS.map((o) => gen(o, 100)),
  month: () => MONTHS.map((m) => gen(m, 12000)), week: () => WEEKS.map((w) => gen(w, 3000)), date: () => DATES.map((d) => gen(d, 800)),
  touch_campaign: () => withCamps(TOUCH, 3500), medium_campaign: () => withCamps(MEDIUM, 4000),
};
const DIM_LABEL: Record<string, string> = {
  campaign: 'Campaign', touch_point: 'Touch point', medium: 'Medium', lead_source: 'Lead source', class: 'Class (Lead Master)', owner: 'Lead owner',
  month: 'Month', week: 'Week', date: 'Date', touch_campaign: 'Touch point › campaign', medium_campaign: 'Medium › campaign',
};

const pctR = (v: unknown) => fmtPct(v as number, 0);
const pct1 = (v: unknown) => fmtPct(v as number);
const pill = (v: unknown) => { const n = v as number; return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${n >= 50 ? 'bg-emerald-100 text-emerald-800' : n >= 30 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>{n}%</span>; };
/** every measure: label, how it shows, and what it means (the comparison table lists them all) */
const METRICS: { key: keyof MRow; header: string; render?: (v: unknown) => React.ReactNode; title: string; higherBetter: boolean }[] = [
  { key: 'leads', header: 'Leads', title: 'leads in the filters', higherBetter: true },
  { key: 'called_pct', header: 'Called %', render: pctR, title: 'leads with at least one call', higherBetter: true },
  { key: 'calls', header: 'Calls', title: 'calls on those leads', higherBetter: true },
  { key: 'calls_per_lead', header: 'Calls per called lead', title: 'calls ÷ leads called', higherBetter: true },
  { key: 'connected_pct', header: 'Connected %', render: pctR, title: 'leads with a connected call ÷ leads called', higherBetter: true },
  { key: 'talk_h', header: 'Talk time (h)', title: 'sum of connected seconds', higherBetter: true },
  { key: 'avg_talk_min', header: 'Avg talk (min)', title: 'talk time ÷ connected calls', higherBetter: true },
  { key: 'effort_pct', header: 'Enough effort %', render: pill, title: 'connected, or 3+ calls tried', higherBetter: true },
  { key: 'converted', header: 'Converted', title: 'Overview rule', higherBetter: true },
  { key: 'conv_pct', header: 'Conv %', render: pct1, title: 'converted ÷ leads', higherBetter: true },
  { key: 'calls_before', header: 'Avg calls before conversion', title: 'calls before the payment ÷ converted leads', higherBetter: false },
  { key: 'first_call_h', header: 'Hours to first call', title: 'median, called leads', higherBetter: false },
  { key: 'missed', header: 'Missed calls', title: 'incoming calls from leads not picked up', higherBetter: false },
  { key: 'rejected_pct', header: 'Rejected %', render: pct1, title: 'outgoing calls the lead rejected', higherBetter: false },
];
const colsFor = (keys: (keyof MRow)[], first = ''): Col<MRow>[] => [
  { key: 'key', header: first, render: (v) => <span className="block min-w-[8rem] max-w-[16rem] whitespace-normal leading-snug">{String(v)}</span> },
  ...keys.map((k, i) => { const m = METRICS.find((x) => x.key === k)!; return { key: k, header: m.header, bar: i === 0, render: m.render } as Col<MRow>; }),
];

// ---------- lead-basis cards
const FUNNEL = [{ key: 'Total leads', value: 24718 }, { key: 'Called', value: 15940 }, { key: 'Connected', value: 11214 }, { key: 'Converted', value: 1143 }];
const REASONS = [
  { key: 'Never called', value: 8778, note: 'no call since the touch or creation', tone: 'bg-red-500' },
  { key: 'Called 1–2 times, never connected', value: 2310, note: 'calling stopped before the 3rd try', tone: 'bg-orange-500' },
  { key: 'Called 3+ times, never connected', value: 2416, note: 'enough tries · the lead did not pick up · 4.1 tries on average', tone: 'bg-amber-400' },
  { key: 'Connected, not converted', value: 10071, note: 'top reasons: Not interested 31% · Fee too high 18% · Joined elsewhere 12%', tone: 'bg-emerald-500' },
];
const BY_CALLS = [
  { key: '0 calls', value: 8778, secondary: 0.9 }, { key: '1–2 calls', value: 5310, secondary: 2.8 }, { key: '3–5 calls', value: 6470, secondary: 6.9 },
  { key: '6–10 calls', value: 3150, secondary: 11.4 }, { key: '11+ calls', value: 1010, secondary: 15.2 },
];
const BY_CONNECTED = [
  { key: '0 connected', value: 13504, secondary: 1.2 }, { key: '1 connected', value: 5920, secondary: 4.8 }, { key: '2–3 connected', value: 3850, secondary: 9.6 }, { key: '4+ connected', value: 1444, secondary: 17.9 },
];
const FIRST_CALL = [
  { key: 'Same hour', value: 3920, secondary: 8.1 }, { key: '1–6 h', value: 4210, secondary: 6.2 }, { key: '6–24 h', value: 3880, secondary: 4.9 },
  { key: '1–3 days', value: 2510, secondary: 3.6 }, { key: '3+ days', value: 1420, secondary: 2.2 }, { key: 'Never called', value: 8778, secondary: 0.9 },
];
const ATTEMPTS = [
  { key: '1st call', value: 5980, secondary: 53.3 }, { key: '2nd call', value: 2410, secondary: 21.5 }, { key: '3rd call', value: 1260, secondary: 11.2 },
  { key: '4–5 calls', value: 970, secondary: 8.6 }, { key: '6+ calls', value: 594, secondary: 5.3 },
];
// ---------- call-basis cards
const RESULTS = [
  { key: 'Outgoing · connected', value: 88420 }, { key: 'Outgoing · not connected', value: 148590 }, { key: 'Incoming', value: 18034 },
  { key: 'Missed', value: 18421 }, { key: 'Rejected', value: 1437 }, { key: 'Blocked', value: 98 },
];
const CALL_CLASS = CLASSES.map((c) => ({ key: c, value: 20000 + (hash(c) % 50) * 800, secondary: 28 + (hash(c) % 20) }));
// ---------- shared cards
const MISSED = [{ key: 'Called back within 1 h', value: 1840 }, { key: 'Called back in 1–24 h', value: 960 }, { key: 'Called back after a day', value: 410 }, { key: 'Never called back', value: 735 }];
type RejRow = { key: string; calls: number; missed_pct: number; rejected_pct: number; blocked_pct: number };
const REJECTED: RejRow[] = TOUCH.map((t) => ({ key: t, calls: 4000 + (hash(t) % 40) * 450, missed_pct: 22 + (hash(t) % 27), rejected_pct: r1(3 + (hash(t) % 12)), blocked_pct: r1((hash(t) % 21) / 10) }));
const REJ_COLS: Col<RejRow>[] = [
  { key: 'key', header: '' }, { key: 'calls', header: 'Calls', bar: true }, { key: 'missed_pct', header: 'Missed %', render: pctR },
  { key: 'rejected_pct', header: 'Rejected %', render: pct1 }, { key: 'blocked_pct', header: 'Blocked %', render: pct1 },
];
const HOURS = ['9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const connectPct = (d: string, h: string) => { const hi = Number(h); const base = 30 + 10 * Math.sin((hi - 9) / 3) + (hi >= 17 && hi <= 19 ? 9 : 0); return Math.round(base - (d === 'Sun' ? 8 : d === 'Sat' ? 3 : 0)); };
const DAILY = DATES.map((d, i) => {
  const calls = Math.max(9000, 21000 + Math.round(5000 * Math.sin(i / 3) + (new Date(d).getUTCDay() === 0 ? -9000 : 0)));
  return { d: d.slice(5), calls, connected: Math.round(calls * 0.37), conversions: Math.round(30 + 12 * Math.sin(i / 2.5)) };
});

// Calls and conversion (2026-11-28): rows by one field, optionally split by a second
const SPLIT_VALUES: Record<string, string[]> = { touch_point: TOUCH, medium: MEDIUM, campaign: CAMPS, lead_source: SOURCE };
const splitRows = (by: string, split: string): MRow[] => SPLIT_VALUES[by]!.map((p) => ({ ...gen(p, 3500), children: split === 'none' ? undefined
  : SPLIT_VALUES[split]!.filter((c) => c !== p).slice(0, 2 + (hash(p + split) % 4)).map((c) => gen(`${p}|${c}`, 3500 / 4)) }));
// Talk time and conversion (2026-11-28): leads by their total talk time, the lead owner's calls or everyone's, over N days
const talkBands = (who: string, days: number) => {
  const f = (days / 30) * (who === 'owner' ? 0.7 : 1);
  return [
    { key: 'No talk', value: Math.round(9810 / Math.max(f, 0.3)), secondary: 0.8 }, { key: 'Under 2 min', value: Math.round(6240 * f), secondary: 2.4 },
    { key: '2 – 10 min', value: Math.round(4320 * f), secondary: 7.9 }, { key: '10 – 30 min', value: Math.round(2440 * f), secondary: 16.2 }, { key: '30 min +', value: Math.round(910 * f), secondary: 27.5 },
  ];
};

type Pick = { dim: string; label: string; key: string };

export default function Calls() {
  const cf = useCallFilters();
  const isCall = cf.basis === 'call';

  // a click anywhere filters every card (2026-11-28): one pick per card, shown as chips; the real page sends these with the request
  const [picks, setPicks] = useState<Pick[]>([]);
  const toggle = (dim: string, label: string, key: string) => setPicks((ps) => {
    const same = ps.find((p) => p.dim === dim);
    const rest = ps.filter((p) => p.dim !== dim);
    return same?.key === key ? rest : [...rest, { dim, label, key }];
  });
  const isPicked = (dim: string, key: string) => picks.some((p) => p.dim === dim && p.key === key);
  // sample data: shrink the counts with each pick so the reaction is visible
  const k = picks.reduce((a, p) => a * (0.2 + (hash(p.dim + p.key) % 40) / 100), 1);
  const sc = (n: number) => Math.round(n * k);
  const bars = (dim: string, d: { key: string; value: number; secondary?: number }[]) => d.map((x) => ({ ...x, value: isPicked(dim, x.key) ? x.value : sc(x.value), selected: isPicked(dim, x.key) }));
  const scRows = (rows: MRow[]): MRow[] => rows.map((r) => ({ ...r, leads: sc(r.leads), calls: sc(r.calls), converted: sc(r.converted), missed: sc(r.missed), talk_h: r1(r.talk_h * k), children: r.children ? scRows(r.children) : undefined }));

  const [bandBy, setBandBy] = useState<'calls' | 'connected'>('calls');
  const bands = bandBy === 'calls' ? BY_CALLS : BY_CONNECTED;

  // Calls and conversion: one level, or touch point / medium with their campaigns under them
  const [srcBy, setSrcBy] = useState<'touch_point' | 'medium' | 'campaign' | 'lead_source'>('touch_point');
  const [srcSplit, setSrcSplit] = useState<'none' | 'touch_point' | 'medium' | 'campaign' | 'lead_source'>('medium');
  const split = srcSplit === srcBy ? 'none' : srcSplit;
  const srcRows = useMemo(() => splitRows(srcBy, split), [srcBy, split]);
  const SRC_KEYS: (keyof MRow)[] = ['leads', 'called_pct', 'calls_per_lead', 'connected_pct', 'effort_pct', 'converted', 'conv_pct', 'calls_before'];
  const nested = split !== 'none';
  const srcDim = srcBy;

  // talk time and conversion: the lead owner's talk time (or everyone's) on the lead, summed over N days to yesterday
  const [talkWho, setTalkWho] = useState<'owner' | 'all'>('owner');
  const [talkDays, setTalkDays] = useState<'7' | '10' | '30' | '90'>('30');
  const talk = talkBands(talkWho, Number(talkDays));
  const talkHours = sc(Math.round(4120 * (Number(talkDays) / 30) * (talkWho === 'owner' ? 0.7 : 1)));

  // comparison table: rows by any dimension, any measures, optional change vs the previous period
  const [cmpBy, setCmpBy] = useState<keyof typeof DIM_ROWS>('touch_point');
  const [cmpKeys, setCmpKeys] = useState<(keyof MRow)[]>(['leads', 'called_pct', 'connected_pct', 'talk_h', 'effort_pct', 'converted', 'conv_pct']);
  const [cmpPrev, setCmpPrev] = useState(false);
  const [cmpSearch, setCmpSearch] = useState('');
  const cmpRows = useMemo(() => {
    const q = cmpSearch.trim().toLowerCase();
    return scRows(DIM_ROWS[cmpBy]!()).filter((r) => !q || r.key.toLowerCase().includes(q)).map((r) => {
      if (!cmpPrev) return r;
      const o: Record<string, unknown> = { ...r };
      for (const m of cmpKeys) { const v = r[m] as number; const prev = (v as number) * (0.8 + rnd(hash(r.key), hash(String(m))) * 0.4); o[`${String(m)}_chg`] = prev ? r1(((v - prev) / prev) * 100) : null; }
      return o as MRow;
    });
  }, [cmpBy, cmpSearch, cmpPrev, cmpKeys, k]);
  const cmpCols: Col<MRow>[] = useMemo(() => {
    const base = colsFor(cmpKeys, DIM_LABEL[cmpBy]);
    if (!cmpPrev) return base;
    return [base[0]!, ...cmpKeys.flatMap((m, i) => {
      const meta = METRICS.find((x) => x.key === m)!;
      const chg: Col<MRow> = { key: `${String(m)}_chg` as keyof MRow, header: 'Change', render: (v) => { const n = v as number | null; if (n == null) return '–'; const good = meta.higherBetter ? n >= 0 : n <= 0; return <span className={good ? 'text-emerald-700' : 'text-red-700'}>{n > 0 ? '+' : ''}{n}%</span>; } };
      return [base[i + 1]!, chg];
    })];
  }, [cmpKeys, cmpBy, cmpPrev]);
  const toggleMetric = (m: keyof MRow) => setCmpKeys((ks) => (ks.includes(m) ? (ks.length > 1 ? ks.filter((x) => x !== m) : ks) : METRICS.map((x) => x.key).filter((x) => ks.includes(x) || x === m)));

  const { f } = useFilters();
  const prev = useMemo(() => {
    const day = 86400000, a = Date.parse(f.from), b = Date.parse(f.to), n = Math.round((b - a) / day) + 1;
    const fmt = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return { n, text: `${fmt(a - n * day)} – ${fmt(a - day)}` };
  }, [f.from, f.to]);
  const TOTAL = sc(24718);
  const share = (v: number) => (TOTAL ? (v / TOTAL) * 100 : 0);
  const byText = cf.by === 'owner' ? 'calls by the lead owner' : 'calls by anyone';

  return (
    <div className="space-y-4">
      <PageHeader title="Lead Call Analytics" subtitle={isCall
        ? `Draft · sample numbers · Call date basis: every Callyzer call dated in the range, matched to its lead by phone number · ${byText}`
        : `Draft · sample numbers · Lead basis: the leads in the filters, with their Callyzer calls since the touch or creation · ${byText}`} />
      <Note><b>Draft for review.</b> Every figure is a sample. Click any bar, row, cell or day: every card follows it. Calls exist from 10 Oct 2026, when Callyzer started.</Note>

      {picks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink-3">Filtered by</span>
          {picks.map((p) => (
            <button key={p.dim} type="button" className="chip" title="Remove" onClick={() => toggle(p.dim, p.label, p.key)}><b>{p.label}</b>: {p.key} ×</button>
          ))}
          <button type="button" className="text-ink-3 hover:text-ink hover:underline" onClick={() => setPicks([])}>Clear all</button>
        </div>
      )}

      {isCall ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiTile tone="tone-brand" icon={<Icon.Spark />} title="Calls" value={fmtInt(sc(275000))} sub={`${fmtInt(sc(22100))} a day · ${fmtInt(sc(2412))} calls not to a lead`} />
          <KpiTile tone="tone-teal" icon={<Icon.Users />} title="Leads called" value={fmtInt(sc(61840))} sub="unique leads with a call in the dates" />
          <KpiTile tone="tone-violet" icon={<Icon.Check />} title="Connected calls" value={fmtInt(sc(88420))} sub="32.2% of calls" />
          <KpiTile tone="tone-green" icon={<Icon.Calendar />} title="Talk time" value={`${fmtInt(sc(4120))} h`} sub="2.8 min per connected call" />
          <KpiTile tone="tone-amber" icon={<Icon.Users />} title="Callers" value={fmtInt(413)} sub="Callyzer users with a call in the dates" />
          <KpiTile tone="tone-red" icon={<Icon.Spark />} title="Missed from leads" value={fmtInt(sc(3945))} sub={`${fmtInt(sc(735))} never called back`} />
          <KpiTile tone="tone-orange" icon={<Icon.Check />} title="Converted after a call" value={fmtInt(sc(1980))} sub="leads called in the dates · paid after that call, up to today" />
          <KpiTile tone="tone-pink" icon={<Icon.Avg />} title="Calls per lead called" value="4.4" sub={`${fmtInt(sc(275000))} calls ÷ ${fmtInt(sc(61840))} leads`} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiTile tone="tone-green" icon={<Icon.Users />} title="Total leads" value={fmtInt(TOTAL)} sub="Same as Overview" />
          <KpiTile tone="tone-teal" icon={<Icon.Touch />} title="Leads called" value={fmtInt(sc(15940))} sub={`${fmtPct(share(sc(15940)))} of leads · ${fmtInt(sc(8778))} never called`} />
          <KpiTile tone="tone-brand" icon={<Icon.Spark />} title="Calls since the touch" value={fmtInt(sc(61204))} sub="3.84 per called lead · from the touch or creation to today" />
          <KpiTile tone="tone-violet" icon={<Icon.Check />} title="Leads connected" value={fmtInt(sc(11214))} sub={`${fmtPct(share(sc(11214)))} of leads · ${fmtInt(sc(412))} h talk time`} />
          <KpiTile tone="tone-amber" icon={<Icon.Users />} title="Enough effort" value={fmtInt(sc(13630))} sub={`${fmtPct(share(sc(13630)))} of leads = connected, or 3+ calls tried`} />
          <KpiTile tone="tone-orange" icon={<Icon.Check />} title="Converted" value={fmtInt(sc(1143))} sub={`${fmtPct(share(sc(1143)))} of leads · Overview rule`} />
          <KpiTile tone="tone-pink" icon={<Icon.Avg />} title="Avg calls before conversion" value="4.2" sub={`${fmtInt(sc(4801))} calls from the touch to the payment ÷ ${fmtInt(sc(1143))} converted`} />
          <KpiTile tone="tone-slate" icon={<Icon.Calendar />} title="First call after touch" value="6.5 h" sub="Median · leads called at least once" />
        </div>
      )}

      {!isCall && <>
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title="Call funnel" tone="tone-brand" subtitle="Each step as a share of Total leads · click a step to filter" rows={FUNNEL} height={FUNNEL.length * 34 + 16} fitContent
            help="Called = a call on the lead's number since its touch or creation. Connected = at least one connected call. Converted = the Overview rule.">
            <HBars colorful data={bars('funnel', FUNNEL.map((s) => ({ key: s.key, value: s.value, secondary: share(s.value) })))} valueLabel="Leads" secondaryLabel="Share of leads" onClick={(x) => toggle('funnel', 'Step', x)} />
          </ChartCard>
          <ChartCard title="Why leads did not convert" tone="tone-red" subtitle="Leads not converted, by how far the calling got · click a group to filter" rows={REASONS} height={FUNNEL.length * 34 + 16} fitContent
            help="Enough effort = the lead connected, or 3+ calls were tried. Two calls with a connect on the second count as enough. Top reasons = the Reason logged on the last Salesforce call.">
            <div className="flex flex-col gap-1.5">
              {REASONS.map((r) => (
                <button key={r.key} type="button" onClick={() => toggle('reason_group', 'Why', r.key)}
                  className={`rounded-xl border px-3 py-1.5 text-left transition hover:border-accent/40 ${isPicked('reason_group', r.key) ? 'border-accent bg-accent/5' : 'border-line'}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-semibold text-ink"><span className={`h-2 w-2 rounded-full ${r.tone}`} />{r.key}</span>
                    <span className="text-base font-extrabold tabular-nums">{fmtInt(isPicked('reason_group', r.key) ? r.value : sc(r.value))}</span>
                  </div>
                  <div className="text-[11px] text-ink-3">{r.note}</div>
                </button>
              ))}
            </div>
          </ChartCard>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <ChartCard title="Conversion by calls made" tone="tone-teal" subtitle="Leads by calls · tooltip = conversion %" rows={bands} height={FIRST_CALL.length * 28 + 16}
            titleAddon={<Segmented size="xs" value={bandBy} onChange={setBandBy} options={[{ value: 'calls', label: 'Calls' }, { value: 'connected', label: 'Connected' }]} />}>
            <HBars colorful data={bars('calls_band', bands)} valueLabel="Leads" secondaryLabel="Conversion" onClick={(x) => toggle('calls_band', 'Calls', x)} />
          </ChartCard>
          <ChartCard title="Time to first call" tone="tone-amber" subtitle="From the touch or creation · tooltip = conversion %" rows={FIRST_CALL} height={FIRST_CALL.length * 28 + 16}>
            <HBars colorful data={bars('first_call', FIRST_CALL)} valueLabel="Leads" secondaryLabel="Conversion" onClick={(x) => toggle('first_call', 'First call', x)} />
          </ChartCard>
          <ChartCard title="Attempts to first connect" tone="tone-violet" subtitle="Connected leads by the call they first picked up · tooltip = share" rows={ATTEMPTS} height={FIRST_CALL.length * 28 + 16}>
            <HBars colorful data={bars('attempts', ATTEMPTS)} valueLabel="Leads" secondaryLabel="Share" onClick={(x) => toggle('attempts', 'First connect', x)} />
          </ChartCard>
        </div>
      </>}

      {isCall && (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title="Calls by result" tone="tone-brand" subtitle="Calls in the dates by type and connection · click to filter" rows={RESULTS} height={RESULTS.length * 28 + 16}>
            <HBars colorful data={bars('result', RESULTS)} valueLabel="Calls" onClick={(x) => toggle('result', 'Result', x)} />
          </ChartCard>
          <ChartCard title="Calls by class" tone="tone-violet" subtitle="Calls by the class on the lead · tooltip = connect % · click to filter" rows={CALL_CLASS} height={RESULTS.length * 28 + 16}>
            <HBars colorful data={bars('class', CALL_CLASS)} valueLabel="Calls" secondaryLabel="Connect %" onClick={(x) => toggle('class', 'Class', x)} />
          </ChartCard>
        </div>
      )}

      <ChartCard title="Calls and conversion" tone="tone-pink" isTable fitContent rows={srcRows} columns={colsFor(SRC_KEYS)} height={260} fileName="Calls and conversion"
        subtitle={nested ? `Each lead once, under its ${DIM_LABEL[srcBy]!.toLowerCase()} · click + to split by ${DIM_LABEL[split]!.toLowerCase()} · click a row to filter` : 'Each lead once, under its value · click a row to filter'}
        titleAddon={<span className="flex items-center gap-1.5 text-xs text-ink-3">
          <select className="input h-7 py-0 text-xs" value={srcBy} onChange={(e) => setSrcBy(e.target.value as typeof srcBy)}>
            {(['touch_point', 'medium', 'campaign', 'lead_source'] as const).map((d) => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
          </select>
          split by
          <select className="input h-7 py-0 text-xs" value={split} onChange={(e) => setSrcSplit(e.target.value as typeof srcSplit)}>
            <option value="none">Nothing</option>
            {(['touch_point', 'medium', 'campaign', 'lead_source'] as const).filter((d) => d !== srcBy).map((d) => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
          </select>
        </span>}>
        <DataTable key={srcBy + split} rows={scRows(srcRows)} columns={colsFor(SRC_KEYS)} compact maxHeight="100%" initialSort={{ id: 'leads', desc: true }}
          highlight={(r) => isPicked(srcDim, r.key)}
          onRowClick={(r) => toggle(srcDim, DIM_LABEL[srcDim]!, r.key)}
          subRows={nested ? (r) => r.children?.map((c) => ({ ...c, key: c.key.split('|')[1]! })) : undefined}
          onSubRowClick={nested ? (_p, c) => toggle(split, DIM_LABEL[split]!, c.key) : undefined} />
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Talk time and conversion" tone="tone-teal" rows={talk} height={talk.length * 28 + 16}
          subtitle={`Leads by total talk time · ${fmtInt(talkHours)} h in all · ${talkWho === 'owner' ? "the lead owner's calls" : 'calls by anyone'} · last ${talkDays} days · tooltip = conversion %`}
          titleAddon={<Segmented size="xs" value={talkWho} onChange={setTalkWho} options={[{ value: 'owner', label: 'Lead owner', title: 'talk time of calls by the owner of the lead' }, { value: 'all', label: 'Everyone', title: 'talk time of calls by anyone' }]} />}
          actions={<Segmented size="xs" value={talkDays} onChange={setTalkDays} options={[{ value: '7', label: '7 d' }, { value: '10', label: '10 d' }, { value: '30', label: '30 d' }, { value: '90', label: '90 d' }]} />}
          help="Talk time = the connected seconds of every call on the lead in the last N days, to yesterday, added up. Lead owner = only calls by the lead's owner in Salesforce, matched to Callyzer by employee code.">
          <HBars colorful data={bars('talk_band', talk)} valueLabel="Leads" secondaryLabel="Conversion" onClick={(x) => toggle('talk_band', 'Talk time', x)} />
        </ChartCard>
        <ChartCard title="Missed calls from leads" tone="tone-red" subtitle={`${fmtInt(sc(3945))} incoming calls missed · how soon a BDE called back`} rows={MISSED} height={talk.length * 28 + 16}>
          <HBars colorful data={bars('missed', MISSED)} valueLabel="Missed calls" onClick={(x) => toggle('missed', 'Missed', x)} />
        </ChartCard>
      </div>

      <div>
        <ChartCard title="Missed, rejected and blocked" tone="tone-amber" isTable fitContent rows={REJECTED} columns={REJ_COLS} height={200} subtitle="Outgoing calls by touch point · click a row to filter">
          <DataTable rows={REJECTED.map((r) => ({ ...r, calls: sc(r.calls) }))} columns={REJ_COLS} compact maxHeight="100%" initialSort={{ id: 'calls', desc: true }}
            highlight={(r) => isPicked('touch_point', r.key)} onRowClick={(r) => toggle('touch_point', 'Touch point', r.key)} />
        </ChartCard>
      </div>

      <ChartCard title="Best time to call" tone="tone-violet" subtitle="Connect % of outgoing calls by weekday and hour · click a cell to filter" rows={DOW.flatMap((d) => HOURS.map((h) => ({ day: d, hour: h, connect_pct: connectPct(d, h) })))} height={260} fitContent>
        <Heatmap rows={DOW} cols={HOURS} rowLabel="Day" colLabel="Hour" get={(r, c) => connectPct(r, c)} format={(v) => `${v}%`} onClick={(r, c) => toggle('slot', 'Time', `${r} ${c}:00`)}
          colText={(c) => `${c}:00`} cellTitle={(r, c, v) => `${r} ${c}:00 · ${v}% of calls connected`} />
      </ChartCard>

      <ChartCard title="Calls per day" tone="tone-green" subtitle="Calls, connected calls and conversions by day · click a day to filter" rows={DAILY} height={260}>
        <DailyLines data={DAILY.map((d) => ({ ...d, calls: sc(d.calls), connected: sc(d.connected), conversions: sc(d.conversions) }))} xKey="d"
          lines={[{ key: 'calls', label: 'Calls' }, { key: 'connected', label: 'Connected' }, { key: 'conversions', label: 'Conversions' }]} onClick={(x) => toggle('day', 'Day', x)} />
      </ChartCard>

      <ChartCard title="Compare" tone="tone-brand" isTable fitContent rows={cmpRows} columns={cmpCols} height={320} fileName="Compare"
        subtitle={`${fmtInt(cmpRows.length)} rows by ${DIM_LABEL[cmpBy]!.toLowerCase()} · pick the measures below${cmpPrev ? ` · Change = against ${prev.text}, the ${prev.n} days just before the dates` : ''}`}
        titleAddon={<select className="input h-7 py-0 text-xs" value={cmpBy} onChange={(e) => setCmpBy(e.target.value as keyof typeof DIM_ROWS)}>
          {(['touch_point', 'campaign', 'medium', 'lead_source', 'class', 'owner', 'month', 'week', 'date'] as const).map((d) => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
        </select>}
        actions={<div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-2"><input type="checkbox" checked={cmpPrev} onChange={(e) => setCmpPrev(e.target.checked)} />Compare with {prev.text}</label>
          <CardSearch value={cmpSearch} onChange={setCmpSearch} count={cmpRows.length} />
        </div>}>
        <div className="mb-2 flex flex-wrap gap-1">
          {METRICS.map((m) => (
            <button key={String(m.key)} type="button" title={m.title} onClick={() => toggleMetric(m.key)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${cmpKeys.includes(m.key) ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-line text-ink-3 hover:text-ink'}`}>{m.header}</button>
          ))}
        </div>
        <DataTable key={cmpBy} rows={cmpRows} columns={cmpCols} compact maxHeight="100%" initialSort={cmpBy === 'month' || cmpBy === 'week' || cmpBy === 'date' ? undefined : { id: cmpKeys[0]! as string, desc: true }}
          highlight={(r) => isPicked(cmpBy, r.key)} onRowClick={(r) => toggle(cmpBy, DIM_LABEL[cmpBy]!, r.key)} />
      </ChartCard>

      <Note><b>How it counts.</b> Lead basis: calls from the lead's touch or creation in the dates, up to today; every call counts, not only the first or last. Converted = the Overview rule (first valid payment after the touch). Avg calls before conversion = calls between the touch and the payment. Call date basis: calls dated in the range; converted = a lead called in the range who paid after that call, up to today. Enough effort = connected, or 3+ calls tried.</Note>
    </div>
  );
}
