import type { IncomingMessage } from 'http';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { getDb } from '../db/connection.js';
import { registerCrud, toApi } from './crud.js';
import { transactionRoutes } from './routes/transactions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { eventRoutes } from './routes/events.js';
import { categoryRoutes } from './routes/categories.js';
import { agentRoutes } from './agent.js';
import { insuranceRoutes } from './routes/insurance.js';
import { pensionRoutes } from './routes/pension.js';
import { investmentRoutes } from './routes/investments.js';
import { setRate } from '../analytics/fx.js';
import { FEATURES, HOSTED } from '../features.js';
import { hostedRoutes } from './routes/hosted.js';

const db = getDb();
// Local-only: this API exposes the household's full financial data and has no login.
// Hosted, the container is the boundary — see the onRequest guard below.
const HOST = HOSTED ? '0.0.0.0' : '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4310);

/** The prefix this instance is mounted under ('' locally, '/a/familycfo' hosted). Must match the
 *  SPA's build-time base — the Dockerfile sets both from one build arg. */
const BASE_PATH = (process.env.FAMILYCFO_BASE_PATH ?? '').replace(/\/+$/, '');

/** Is this URL addressed to our mount? `/a/familycfo`, `/a/familycfo/x` and `/a/familycfo?q` are;
 *  `/a/familycfo-other` and a bare `/api/meta` are not. Always true when nothing is mounted. */
function isUnderBase(url: string): boolean {
  if (!BASE_PATH) return true;
  return url === BASE_PATH || url.startsWith(`${BASE_PATH}/`) || url.startsWith(`${BASE_PATH}?`);
}

/** The gateway forwards the URL verbatim, so the prefix arrives here; the routes never see it.
 *  Anything not under the mount is left alone and refused by the onRequest guard. */
function stripBase(url: string): string {
  if (!isUnderBase(url)) return url;
  const rest = url.slice(BASE_PATH.length);
  return rest.startsWith('?') || rest === '' ? `/${rest}` : rest;
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  ...(BASE_PATH ? { rewriteUrl: (req: IncomingMessage) => stripBase(req.url ?? '/') } : {}),
});

/**
 * Local-only has to mean local. Binding to 127.0.0.1 keeps the network out but not the browser: a site
 * whose DNS name is rebound to 127.0.0.1 is same-origin with this API and would otherwise be able to
 * read the whole household, start a scrape or drive the chat. So serve loopback Host headers only, and
 * refuse a cross-site Origin. The web app passes both: Vite proxies /api from 127.0.0.1:WEB_PORT.
 */
function isLoopback(host: string | undefined): boolean {
  if (!host || /[@/\\]/.test(host)) return false;
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); } catch { return false; }
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

const originHost = (origin: string) => (URL.canParse(origin) ? new URL(origin).host.toLowerCase() : undefined);

app.addHook('onRequest', async (req, reply) => {
  // `originalUrl` is the URL as it arrived, before rewriteUrl stripped the mount prefix. Everything
  // this instance serves lives under that prefix; anything else is addressed to something that is
  // not this app, and answering it would be a second, undocumented URL space for the same routes.
  if (!isUnderBase(req.originalUrl)) return reply.code(404).send({ error: 'not found' });
  const { host, origin } = req.headers;
  // Hosted: only the gateway can reach this container, and it forwards Host and Origin verbatim,
  // so the rebinding/CSRF protection survives as a same-origin test. Accepted explicitly: there is
  // no login here — what separates two visitors is that they are in two different containers.
  // Host itself cannot be pinned: the broker's readiness probe asks for the container's own IP.
  if (HOSTED) {
    if (origin !== undefined && originHost(origin) !== String(host ?? '').toLowerCase()) {
      return reply.code(403).send({ error: 'cross-origin request refused' });
    }
    return;
  }
  if (!isLoopback(host)) return reply.code(403).send({ error: 'this API answers on 127.0.0.1 only' });
  if (origin !== undefined && !isLoopback(originHost(origin))) {
    return reply.code(403).send({ error: 'cross-origin request refused' });
  }
});

registerCrud(app, db, { table: 'members', path: 'members', columns: ['name', 'color'], allowDelete: false });
registerCrud(app, db, {
  table: 'accounts', path: 'accounts', idType: 'text', allowCreate: false, allowDelete: false,
  columns: ['displayName', 'ownerMemberId', 'billingBankAccountId', 'active'], orderBy: 'kind, id',
});
registerCrud(app, db, { table: 'businesses', path: 'businesses', columns: ['name', 'color', 'archived'], orderBy: 'name' });
registerCrud(app, db, { table: 'tags', path: 'tags', columns: ['name', 'color', 'startDate', 'endDate', 'budget', 'notes', 'archived'], orderBy: 'name' });
registerCrud(app, db, { table: 'sinking_funds', path: 'funds', columns: ['name', 'monthlyTarget', 'balance', 'goalAmount', 'goalDate'] });
registerCrud(app, db, {
  table: 'assets', path: 'assets', orderBy: 'type, name',
  columns: ['name', 'type', 'provider', 'ownerMemberId', 'currency', 'liquidityDate', 'managementFee', 'monthlyDeposit', 'notes', 'archived'],
});
registerCrud(app, db, { table: 'asset_snapshots', path: 'asset-snapshots', columns: ['assetId', 'date', 'value', 'currency'], orderBy: 'date DESC' });
registerCrud(app, db, {
  table: 'liabilities', path: 'liabilities', orderBy: 'type, name',
  columns: ['name', 'type', 'lender', 'ownerMemberId', 'originalPrincipal', 'interestRate', 'indexType', 'startDate',
    'endDate', 'monthlyPayment', 'paymentDay', 'bankAccountId', 'matchPattern', 'notes', 'archived'],
});
registerCrud(app, db, { table: 'liability_snapshots', path: 'liability-snapshots', columns: ['liabilityId', 'date', 'balance'], orderBy: 'date DESC' });
registerCrud(app, db, {
  table: 'scheduled_items', path: 'scheduled', orderBy: 'day_of_month, name',
  columns: ['name', 'kind', 'amount', 'amountMode', 'dayOfMonth', 'bankAccountId', 'memberId', 'categoryId', 'matchPattern',
    'liabilityId', 'cardAccountId', 'startDate', 'endDate', 'status'],
});

app.get('/api/meta', async () => ({
  members: (db.prepare(`SELECT * FROM members ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
  accounts: (db.prepare(`SELECT * FROM accounts ORDER BY kind, id`).all() as Record<string, unknown>[]).map(toApi),
  categories: (db.prepare(`SELECT * FROM categories ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
  businesses: (db.prepare(`SELECT * FROM businesses ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
  tags: (db.prepare(`SELECT * FROM tags ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
  funds: (db.prepare(`SELECT * FROM sinking_funds ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
  settings: Object.fromEntries((db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]).map(s => [s.key, s.value])),
  features: { ...FEATURES, hosted: HOSTED },
}));

app.put('/api/settings', async req => {
  const body = req.body as Record<string, string | number>;
  const allowed = ['cycle_start_day', 'balance_buffer'];
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(body)) if (allowed.includes(k)) upsert.run(k, String(v));
  return { ok: true };
});

app.get('/api/fx', async () => db.prepare(`
  SELECT currency, rate_to_ils, date, source FROM fx_rates f
  WHERE date = (SELECT MAX(date) FROM fx_rates WHERE currency = f.currency) ORDER BY currency
`).all());
app.put('/api/fx', async req => {
  const b = req.body as { currency: string; rate: number; date?: string };
  setRate(db, b.date ?? new Date().toISOString().slice(0, 10), b.currency, b.rate);
  return { ok: true };
});

transactionRoutes(app, db);
analyticsRoutes(app, db);
eventRoutes(app, db);
categoryRoutes(app, db);
agentRoutes(app, db);
insuranceRoutes(app, db);
pensionRoutes(app, db);
investmentRoutes(app, db);
if (HOSTED) hostedRoutes(app, db);

// Before the static plugin: `await app.register(…)` boots the instance, and a handler attached
// after that never reaches the routes above — their errors would come back in Fastify's default
// shape, which the web client reads as "Bad Request" instead of the reason.
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message });
});

/** The built SPA, in the same place relative to this file in both layouts: src/server/… from tsx,
 *  dist/server/… in the image. Absent on a dev checkout that never ran a build — then the API
 *  serves /api only, exactly as before. */
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(join(WEB_DIST, 'index.html'))) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  // client-side routing: a GET that matched no file and no API route is a page
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ host: HOST, port: PORT });
console.log(`Household API on http://${HOST}:${PORT}`);
