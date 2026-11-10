import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';

/**
 * Manual sync trigger. The sync itself runs in GitHub Actions (sync.yml); the Worker only
 * starts it through the GitHub API and reports the latest run's status.
 * Needs the Worker secret GITHUB_TOKEN (fine-grained PAT, repo scope: Actions read+write)
 * and the var GITHUB_REPO ("owner/repo").
 */
export const syncRoute = new Hono<AppEnv>();

const COOLDOWN_MIN = 10;

interface RunInfo { id: number; status: string; conclusion: string | null; started_at: string; html_url: string; event: string }

async function gh(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!env.GITHUB_TOKEN) throw Object.assign(new Error('Manual sync is not configured: set the GITHUB_TOKEN secret on the Worker'), { status: 503 });
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'eduport-lead-touch', ...(init.headers ?? {}) },
  });
}

async function latestRun(env: Env): Promise<RunInfo | null> {
  const r = await gh(env, '/actions/workflows/sync.yml/runs?per_page=1');
  if (!r.ok) throw Object.assign(new Error(`GitHub API ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 });
  const j = (await r.json()) as { workflow_runs: RunInfo[] };
  const run = j.workflow_runs?.[0];
  return run ? { id: run.id, status: run.status, conclusion: run.conclusion, started_at: run.started_at ?? (run as unknown as { run_started_at: string }).run_started_at, html_url: run.html_url, event: run.event } : null;
}

const RUNNING = ['in_progress', 'queued', 'pending', 'waiting'];
const DAILY_SYNC_HOUR_IST = 6;

/** Is this cron tick (epoch ms) one of the three that may start the daily sync: 06:00, 06:10, 06:20 IST? Returns the IST day, or null. */
export function dailySyncDue(scheduledTime: number): string | null {
  const ist = new Date(scheduledTime + 5.5 * 3600_000);
  return ist.getUTCHours() === DAILY_SYNC_HOUR_IST && ist.getUTCMinutes() < 30 ? ist.toISOString().slice(0, 10) : null;
}

/**
 * The daily sync, started by the Worker's own cron (every 10 minutes, on time) at 06:00 IST. GitHub's scheduler ran the workflow
 * 6 to 8.5 hours late every day (a 10:00 IST schedule started between 16:00 and 18:40 IST), so the schedule in sync.yml is only a
 * fallback. The 06:00 tick dispatches; the 06:10 and 06:20 ticks retry when that failed. A KV marker per IST day makes it once a day.
 */
export async function dailySync(env: Env, scheduledTime: number): Promise<string> {
  const day = dailySyncDue(scheduledTime);
  if (!day) return 'not due';
  if (!env.GITHUB_TOKEN) return 'not configured: GITHUB_TOKEN secret missing';
  const key = `daily-sync:${day}`;
  if (env.CACHE) { if (await env.CACHE.get(key)) return 'already started today'; }
  else if (new Date(scheduledTime + 5.5 * 3600_000).getUTCMinutes() >= 10) return 'no KV marker: only the 06:00 tick dispatches';
  const mark = async (v: string) => { if (env.CACHE) await env.CACHE.put(key, v, { expirationTtl: 2 * 86400 }); };
  const run = await latestRun(env);
  if (run && RUNNING.includes(run.status)) { await mark(`running ${run.id}`); return `a sync is already running (${run.id})`; }
  const r = await gh(env, '/actions/workflows/sync.yml/dispatches', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'main', inputs: { full: false, objects: '' } }),
  });
  if (r.status !== 204) throw new Error(`daily sync dispatch failed: GitHub API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  await mark('started');
  return `started for ${day}`;
}

/** GET /api/sync/status */
syncRoute.get('/sync/status', async (c) => {
  if (!c.env.GITHUB_TOKEN) return c.json({ data: { configured: false, run: null } });
  const run = await latestRun(c.env);
  return c.json({ data: { configured: true, run } }, 200, { 'Cache-Control': 'no-store' });
});

/** POST /api/sync : start an incremental sync + refresh (refuses while one is running or within the cooldown) */
syncRoute.post('/sync', async (c) => {
  const env = c.env;
  const run = await latestRun(env);
  if (run && RUNNING.includes(run.status)) {
    return c.json({ error: { code: 'already_running', message: 'A sync is already running', run } }, 409);
  }
  const started = run?.started_at ? new Date(run.started_at).getTime() : 0;
  if (run && Date.now() - started < COOLDOWN_MIN * 60_000 && run.event === 'workflow_dispatch') {
    return c.json({ error: { code: 'cooldown', message: `Last manual sync was less than ${COOLDOWN_MIN} minutes ago`, run } }, 429);
  }
  const r = await gh(env, '/actions/workflows/sync.yml/dispatches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { full: false, objects: '' } }),
  });
  if (r.status !== 204) return c.json({ error: { code: 'dispatch_failed', message: `GitHub API ${r.status}: ${(await r.text()).slice(0, 200)}` } }, 502);
  return c.json({ data: { started: true, by: c.get('user').email, expected_minutes: 5 } }, 202);
});
