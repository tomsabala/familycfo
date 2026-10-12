import type { FastifyInstance } from 'fastify';
// the definitions module only, so a boot that never scrapes does not pull puppeteer in
import { PASSWORD_FIELD, SCRAPERS } from 'israeli-bank-scrapers/lib/definitions.js';
import { z } from 'zod';
import type { DB } from '../../db/connection.js';
import { resetHousehold } from '../../db/reset.js';
import { seedDemo } from '../../demo.js';
import { runPipeline } from '../../pipeline.js';
import { clearCredentials, countCredentials, deleteCredentials, listCredentials, saveCredentials } from '../secretStore.js';

/**
 * The hosted-only API: the visitor's own bank logins, and the first-run choice between demo data and
 * a real bank. Registered only when HOSTED=1, so a local checkout keeps accounts.json as its single
 * source of logins with no second path to maintain.
 */

interface Provider { companyId: string; name: string; loginFields: string[] }

/** The providers this instance accepts, straight from the scraper library so the form can never
 *  drift from what the scraper takes. oneZero is excluded: its loginFields include
 *  `otpCodeRetriever`, a callback the app has no way to supply from a browser form. */
const PROVIDERS: Provider[] = Object.entries(SCRAPERS)
  .filter(([id]) => id !== 'oneZero')
  .map(([companyId, s]) => ({ companyId, name: s.name, loginFields: s.loginFields }));

const PROVIDER_BY_ID: Record<string, Provider | undefined> = Object.fromEntries(PROVIDERS.map(p => [p.companyId, p]));

/** One container holds one household; a visitor has no reason to connect more than a handful. */
const MAX_PROVIDERS = 10;
const MAX_FIELD_LENGTH = 200;

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

const CredentialBody = z.object({ fields: z.record(z.string(), z.unknown()) });

/** A login the scraper can actually use: exactly this provider's fields, each a non-empty string.
 *  An extra key would be handed to the scraper verbatim, so the set must match exactly. */
function validate(provider: Provider, fields: Record<string, unknown>): Record<string, string> {
  const given = Object.keys(fields).sort();
  const expected = [...provider.loginFields].sort();
  if (given.length !== expected.length || given.some((k, i) => k !== expected[i])) {
    throw bad(`${provider.name} expects exactly these fields: ${provider.loginFields.join(', ')}`);
  }

  const clean: Record<string, string> = {};
  for (const name of provider.loginFields) {
    const value = fields[name];
    if (typeof value !== 'string') throw bad(`"${name}" must be a string`);
    const trimmed = value.trim();
    if (!trimmed) throw bad(`"${name}" is required`);
    if (trimmed.length > MAX_FIELD_LENGTH) throw bad(`"${name}" is too long`);
    clean[name] = trimmed;
  }
  return clean;
}

export function hostedRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/providers', async () => PROVIDERS.map(p => ({
    companyId: p.companyId,
    name: p.name,
    loginFields: p.loginFields.map(name => ({ name, secret: name === PASSWORD_FIELD })),
  })));

  // Which providers are connected, and when — never a field value, not even masked.
  app.get('/api/credentials', async () => listCredentials(db).map(c => ({
    ...c,
    name: PROVIDER_BY_ID[c.companyId]?.name ?? c.companyId,
  })));

  app.put<{ Params: { companyId: string } }>('/api/credentials/:companyId', async (req, reply) => {
    const { companyId } = req.params;
    const provider = PROVIDER_BY_ID[companyId];
    if (!provider) throw bad(`unknown provider "${companyId}"`);
    const body = CredentialBody.safeParse(req.body);
    if (!body.success) throw bad('body must be { fields: { … } }');
    const fields = validate(provider, body.data.fields);
    const connected = listCredentials(db).some(c => c.companyId === companyId);
    if (!connected && countCredentials(db) >= MAX_PROVIDERS) throw bad(`at most ${MAX_PROVIDERS} providers per session`);
    saveCredentials(db, companyId, fields);
    return reply.code(204).send();
  });

  app.delete<{ Params: { companyId: string } }>('/api/credentials/:companyId', async (req, reply) => {
    deleteCredentials(db, req.params.companyId);
    return reply.code(204).send();
  });

  // The first-run choice: made-up data instead of a real bank. Only into an empty household —
  // `manual:entries` does not count, every fresh database has it (migration 10).
  app.post('/api/household/demo', async (_req, reply) => {
    const rows = db.prepare(
      `SELECT (SELECT COUNT(*) FROM accounts WHERE kind != 'manual') + (SELECT COUNT(*) FROM transactions)`
    ).pluck().get() as number;
    if (rows > 0) return reply.code(409).send({ error: 'כבר קיימים נתונים במשק הבית הזה' });
    seedDemo(db);
    const txIds = db.prepare(`SELECT id FROM transactions`).pluck().all() as number[];
    const summary = await runPipeline(db, { txIds });
    db.prepare(`INSERT INTO settings (key, value) VALUES ('demo_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    return summary;
  });

  // Start over — including the stored logins and the key they were encrypted under.
  app.post('/api/household/reset', async () => {
    resetHousehold(db);
    clearCredentials(db);
    return { ok: true };
  });
}
