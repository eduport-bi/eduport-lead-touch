/**
 * Run ONLY the Callyzer step (sql/059): `npm run callyzer`. For the one-off history load and for tests; the nightly sync calls the same
 * syncCallyzer. Env as the sync (DATABASE_URL, CALLYZER_API_KEY; optional CALLYZER_START / CALLYZER_SINCE). Nothing else is touched.
 */
import postgres from 'postgres';
import { txPooler } from './sync-url.js';
import { syncCallyzer } from './callyzer.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Missing env DATABASE_URL');
const sql = postgres(txPooler(url), { max: 1, prepare: false, idle_timeout: 20, transform: { undefined: null }, connection: { application_name: 'lead-touch-callyzer' } });
syncCallyzer(sql)
  .then(async (r) => { console.log(`[callyzer] done: ${r.staff} Sales staff, ${r.calls} calls`); await sql.end({ timeout: 5 }); })
  .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await sql.end({ timeout: 5 }); process.exit(1); });
