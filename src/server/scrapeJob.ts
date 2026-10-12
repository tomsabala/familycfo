import type { DB } from '../db/connection.js';
import type { Config } from '../scraper.js';
import { runPipeline } from '../pipeline.js';
// reads the bank credentials file; the credentials go only to the scraper and are never returned by the API
import { loadConfig } from '../config.js';
import { HOSTED } from '../features.js';
import { storedConfig } from './secretStore.js';

/**
 * One scrape at a time, started from the UI: all banks, then the pipeline. The bank's OTP screen
 * becomes a pending request that the UI answers (POST /api/scrape/otp). State lives in memory —
 * a server restart (tsx watch) ends a running scrape.
 */
export interface ScrapeCompanyState {
  company: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  newTransactions: number;
  error: string | null;
}
export interface ScrapeJobState {
  status: 'idle' | 'running' | 'pipeline' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  companies: ScrapeCompanyState[];
  /** the bank is waiting for an OTP code */
  otp: { company: string; requestedAt: string } | null;
  newTransactions: number;
  error: string | null;
}

const idle = (): ScrapeJobState => ({ status: 'idle', startedAt: null, finishedAt: null, companies: [], otp: null, newTransactions: 0, error: null });
let state: ScrapeJobState = idle();
let answerOtp: ((code: string) => void) | null = null;

export const scrapeState = (): ScrapeJobState => state;
export const scrapeRunning = () => state.status === 'running' || state.status === 'pipeline';

const clearOtp = () => {
  answerOtp?.('');
  answerOtp = null;
  state.otp = null;
};

const setCompany = (company: string, patch: Partial<ScrapeCompanyState>) => {
  state.companies = state.companies.map(c => (c.company === company ? { ...c, ...patch } : c));
};

/**
 * Hosted, /api/scrape is a public endpoint that performs third-party logins from the VPS's IP: a
 * wrong password repeated locks the visitor's own bank account, and the IP is shared by every
 * visitor. Both counters are per container, i.e. per visitor session.
 */
const MIN_INTERVAL_MS = 120_000;   // a bank login attempt every two minutes, at most
const MAX_RUNS = 20;               // per container lifetime
let lastRunAt = 0;
let runCount = 0;

export function startScrape(db: DB): ScrapeJobState {
  if (scrapeRunning()) throw Object.assign(new Error('a scrape is already running'), { statusCode: 409 });
  if (HOSTED) {
    const waitMs = MIN_INTERVAL_MS - (Date.now() - lastRunAt);
    if (waitMs > 0) {
      throw Object.assign(new Error(`סריקה נוספת אפשרית בעוד ${Math.ceil(waitMs / 1000)} שניות`), { statusCode: 429 });
    }
    if (runCount >= MAX_RUNS) {
      throw Object.assign(new Error('הגעת למספר הסריקות המרבי במפגש הזה'), { statusCode: 429 });
    }
  }
  let config: Config;
  try {
    // Hosted, the logins are the visitor's own, from this container's encrypted store; locally they
    // are the operator's accounts.json. Never both.
    config = HOSTED ? storedConfig(db) : loadConfig();
  } catch (err) {
    if (HOSTED) throw err;
    throw Object.assign(new Error('the scraper configuration is missing or invalid (see accounts.example.json)'), { statusCode: 400 });
  }
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  lastRunAt = Date.now();
  runCount += 1;
  state = {
    ...idle(), status: 'running', startedAt: new Date().toISOString(),
    companies: config.accounts.filter(a => !only || only.includes(a.companyId))
      .map(a => ({ company: a.companyId, status: 'pending', newTransactions: 0, error: null })),
  };

  (async () => {
    // Deliberately dynamic, not a static import: `../scraper.js` pulls in israeli-bank-scrapers →
    // puppeteer → a whole Chromium launch stack, and a container boot that never scrapes (every
    // cold start of a 1 GB instance) must not pay for it. Deferred until a scrape actually starts.
    const { scrapeAll } = await import('../scraper.js');
    const results = await scrapeAll(config, db, {
      requestOtp: company => new Promise<string>(resolve => {
        answerOtp = resolve;
        state.otp = { company, requestedAt: new Date().toISOString() };
      }),
      onProgress: event => {
        if (event.type === 'start') setCompany(event.company, { status: 'running' });
        else {
          // a bank that ended (e.g. timed out) no longer needs its code
          if (state.otp?.company === event.company) clearOtp();
          setCompany(event.company, event.success
            ? { status: 'done', newTransactions: event.newTransactions }
            : { status: 'failed', error: event.errorMessage || event.errorType || 'error' });
        }
      },
    });
    state.status = 'pipeline';
    const newIds = results.flatMap(r => r.newTransactionIds);
    state.newTransactions = newIds.length;
    await runPipeline(db, { txIds: newIds, categoryApiUrl: config.categoryApiUrl });
    state.status = results.some(r => r.success) ? 'done' : 'failed';
    if (state.status === 'failed') state.error = 'no bank was scraped';
  })().catch(err => {
    console.error('Scrape job failed:', err);
    state.status = 'failed';
    state.error = err instanceof Error ? err.message : String(err);
  }).finally(() => {
    clearOtp();
    state.finishedAt = new Date().toISOString();
  });

  return state;
}

/** The code the user typed for the bank's OTP screen. */
export function submitOtp(code: string): void {
  if (!answerOtp) throw Object.assign(new Error('no bank is waiting for a code'), { statusCode: 409 });
  if (!/^\d{4,8}$/.test(code)) throw Object.assign(new Error('the code must be 4–8 digits'), { statusCode: 400 });
  const resolve = answerOtp;
  answerOtp = null;
  state.otp = null;
  resolve(code);
}
