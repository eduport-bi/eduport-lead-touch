import type { Env } from './env';
import { withSql } from './db';

/**
 * Response cache for the read-only JSON endpoints.
 *
 * The data only changes when the sync job runs (every 4 hours) and refreshes the materialized views, so a
 * response is keyed on a DATA VERSION (the last successful refresh / sync timestamp) plus the role mask, the
 * path and the sorted query. Two layers:
 *   1. isolate memory (instant, bounded, lost when the isolate is recycled)
 *   2. Workers KV (shared by every isolate and location; the Cache API is not functional on *.workers.dev)
 * A miss runs the query and writes both layers in the background. Errors are never cached.
 *
 * The version itself is read from the database at most once a minute per isolate (stale-while-revalidate),
 * and kept in KV for a minute so a fresh isolate does not pay the round-trip either.
 */

type Ctx = { waitUntil(p: Promise<unknown>): void };

export const VERSION_FRESH_MS = 60_000;          // trust the in-memory version this long
const VERSION_STALE_MAX_MS = 15 * 60_000;        // serve a stale version (while refreshing) at most this long
const MEM_MAX_ENTRIES = 150;
const MEM_MAX_BYTES = 24 * 1024 * 1024;          // the isolate has 128 MB in total
// versioned answers are kept across data versions (2026-11-25): one entry per view holds the LAST answer and the version it was computed for,
// so after a sync a request gets that answer at once (marked stale) while the page asks for the fresh one in the background (http.ts).
// Kept 3 days so the overnight sync never meets an empty entry.
export const KV_TTL_VERSIONED = 3 * 86400;
const KV_VERSION_TTL = 120;

// ---------------------------------------------------------------- data version
let versionMem: { v: string; at: number } | null = null;
let versionInflight: Promise<string> | null = null;

async function readVersionFromDb(env: Env, ctx: Ctx): Promise<string> {
  const rows = await withSql(env, ctx, (sql) => sql<{ v: string | null }[]>`
    SELECT GREATEST((SELECT max(finished_at) FROM analytics.refresh_log WHERE ok),
                    (SELECT max(last_run_at) FROM salesforce._sync_state))::text AS v`);
  return rows[0]?.v ?? 'none';
}

async function fetchVersion(env: Env, ctx: Ctx): Promise<string> {
  // another isolate may have looked it up a moment ago
  const kv = await env.CACHE?.get('version', { cacheTtl: 60 }).catch(() => null);
  if (kv) return kv;
  const v = await readVersionFromDb(env, ctx);
  if (env.CACHE) ctx.waitUntil(env.CACHE.put('version', v, { expirationTtl: KV_VERSION_TTL }).catch(() => undefined));
  return v;
}

/** Current data version; stale-while-revalidate so a request rarely waits for the lookup. */
export async function dataVersion(env: Env, ctx: Ctx): Promise<string> {
  const now = Date.now();
  if (versionMem && now - versionMem.at < VERSION_FRESH_MS) return versionMem.v;
  if (!versionInflight) {
    versionInflight = fetchVersion(env, ctx)
      .then((v) => { versionMem = { v, at: Date.now() }; return v; })
      .finally(() => { versionInflight = null; });
  }
  if (versionMem && now - versionMem.at < VERSION_STALE_MAX_MS) {
    ctx.waitUntil(versionInflight.catch(() => undefined));   // refresh in the background, answer with the stale one
    return versionMem.v;
  }
  return versionInflight;
}

/** Forget the cached version (after an admin refresh) so the next request re-reads it. */
export function forgetVersion(): void { versionMem = null; }

// ---------------------------------------------------------------- key
export async function cacheKey(parts: { version: string; build: string; mask: string; path: string; query: Record<string, string>; user?: string }): Promise<string> {
  const q = Object.keys(parts.query).filter((k) => k !== 'fresh' && k !== 'revalidate').sort().map((k) => `${k}=${parts.query[k]}`).join('&');
  const raw = `${parts.build}|${parts.version}|${parts.mask}|${parts.user ?? ''}|${parts.path}?${q}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `r:${hex.slice(0, 40)}`;
}

// ---------------------------------------------------------------- memory layer (LRU by insertion order)
interface MemEntry { body: string; until: number; bytes: number }
const mem = new Map<string, MemEntry>();
let memBytes = 0;

function memGet(key: string): string | null {
  const e = mem.get(key);
  if (!e) return null;
  if (e.until < Date.now()) { mem.delete(key); memBytes -= e.bytes; return null; }
  mem.delete(key); mem.set(key, e);   // refresh recency
  return e.body;
}

function memSet(key: string, body: string, ttlSec: number): void {
  const bytes = body.length;
  if (bytes > MEM_MAX_BYTES / 4) return;   // one giant answer should not evict everything else
  const old = mem.get(key);
  if (old) { mem.delete(key); memBytes -= old.bytes; }
  mem.set(key, { body, until: Date.now() + ttlSec * 1000, bytes });
  memBytes += bytes;
  while ((mem.size > MEM_MAX_ENTRIES || memBytes > MEM_MAX_BYTES) && mem.size) {
    const k = mem.keys().next().value as string;
    const e = mem.get(k)!; mem.delete(k); memBytes -= e.bytes;
  }
}

export function memStats(): { entries: number; bytes: number } { return { entries: mem.size, bytes: memBytes }; }

// ---------------------------------------------------------------- lookups / stores
export type Hit = { body: string; layer: 'mem' | 'kv' } | null;

export async function cacheGet(env: Env, key: string): Promise<Hit> {
  const m = memGet(key);
  if (m) return { body: m, layer: 'mem' };
  if (!env.CACHE) return null;
  const v = await env.CACHE.get(key, { type: 'text', cacheTtl: 60 }).catch(() => null);
  if (!v) return null;
  return { body: v, layer: 'kv' };
}

export function cachePut(env: Env, ctx: Ctx, key: string, body: string, ttlSec: number): void {
  memSet(key, body, ttlSec);
  if (!env.CACHE || body.length > 20 * 1024 * 1024) return;
  ctx.waitUntil(env.CACHE.put(key, body, { expirationTtl: Math.max(60, ttlSec) }).catch(() => undefined));
}

/** A versioned cache value = the data version it was computed for + newline + the JSON body. */
export const packAnswer = (version: string, body: string) => `${version}\n${body}`;
export function unpackAnswer(raw: string): { version: string | null; body: string } {
  const i = raw.indexOf('\n');
  return raw.startsWith('{') || i < 0 ? { version: null, body: raw } : { version: raw.slice(0, i), body: raw.slice(i + 1) };
}

/** True when the browser asked for a fresh copy (hard reload) or the URL carries fresh=1. */
export function wantsFresh(req: Request, query: Record<string, string>): boolean {
  const cc = (req.headers.get('cache-control') ?? '') + ' ' + (req.headers.get('pragma') ?? '');
  return query.fresh === '1' || /no-cache|no-store/i.test(cc);
}
