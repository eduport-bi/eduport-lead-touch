// Deploys the Worker with a BUILD_ID var (git commit, plus "-dirty" when the tree has uncommitted changes).
// cache.ts puts BUILD_ID into every cache key, so a deploy never serves answers computed by the previous build.
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() ? '-dirty' : '';
const buildId = `${sha}${dirty}-${Date.now().toString(36)}`;
console.log(`BUILD_ID=${buildId}`);
const r = spawnSync('npx', ['wrangler', 'deploy', '--var', `BUILD_ID:${buildId}`], { stdio: 'inherit', shell: true });
if (r.status) process.exit(r.status);

// A deploy empties the response cache (BUILD_ID is part of every key): warm the default views now instead of waiting for the next cron
// run, so the first visitor after a deploy gets cached answers. The secret lives in api/.dev.vars (git-ignored) or WARM_SECRET.
const site = process.env.SITE_URL ?? 'https://leadtouch.eduportbi.workers.dev';
let secret = process.env.WARM_SECRET;
if (!secret) { try { secret = /^WARM_SECRET=(.+)$/m.exec(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'))?.[1]?.trim(); } catch { /* no file */ } }
if (!secret) { console.log('warm: WARM_SECRET not set, the cache warms on the next cron run (within 10 min)'); process.exit(0); }
await new Promise((res) => setTimeout(res, 8000));   // let the new version propagate before the warm-up requests hit it
const t0 = Date.now();
try {
  const res = await fetch(`${site}/api/admin/warm`, { method: 'POST', headers: { 'x-warm-secret': secret } });
  const j = await res.json().catch(() => null);
  const rows = j?.data?.warmed ?? [];
  console.log(`warm: HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s`, rows.map((x) => `${x.status}/${x.cache}/${x.ms}ms`).join(' '));
} catch (e) { console.log('warm failed:', e instanceof Error ? e.message : e); }
