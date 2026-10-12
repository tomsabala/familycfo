import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listCredentials, readCredentials, saveCredentials } from '../src/server/secretStore.js';
import { scrubSecrets } from '../src/scraper.js';
import { resetHousehold } from '../src/db/reset.js';
import { MANUAL_ACCOUNT_ID } from '../src/db/migrations.js';
import { addAccount, addTx, testDb } from './helpers.js';

/** The secret key lives next to $BANK_DB, so every test gets its own throwaway directory. */
let dir: string;
let previousBankDb: string | undefined;

beforeEach(() => {
  previousBankDb = process.env.BANK_DB;
  dir = mkdtempSync(join(tmpdir(), 'familycfo-hosted-'));
  process.env.BANK_DB = join(dir, 'test.db');
});

afterEach(() => {
  if (previousBankDb === undefined) delete process.env.BANK_DB;
  else process.env.BANK_DB = previousBankDb;
  rmSync(dir, { recursive: true, force: true });
});

const LOGIN = { username: 'demo-user', password: 'demo-pass-123' };

describe('stored bank credentials', () => {
  it('stores the login as ciphertext and gives the exact fields back', () => {
    const db = testDb();
    saveCredentials(db, 'leumi', LOGIN);

    const ciphertext = db.prepare(`SELECT ciphertext FROM provider_credentials WHERE company_id = 'leumi'`).pluck().get() as string;
    expect(ciphertext).not.toContain(LOGIN.password);
    expect(ciphertext).not.toContain(LOGIN.username);

    expect(readCredentials(db)).toEqual([{ companyId: 'leumi', credentials: LOGIN }]);
  });

  it('never exposes a field value in the list the UI reads', () => {
    const db = testDb();
    saveCredentials(db, 'leumi', LOGIN);

    const listed = JSON.stringify(listCredentials(db));
    expect(listed).not.toContain(LOGIN.password);
    expect(listed).not.toContain(LOGIN.username);
    expect(listCredentials(db)).toEqual([
      { companyId: 'leumi', hint: 'user', updatedAt: expect.any(String) },
    ]);
  });

  it('treats a tampered row as not configured instead of throwing', () => {
    const db = testDb();
    saveCredentials(db, 'leumi', LOGIN);
    const ciphertext = db.prepare(`SELECT ciphertext FROM provider_credentials WHERE company_id = 'leumi'`).pluck().get() as string;
    const tampered = ciphertext.slice(0, -1) + (ciphertext.endsWith('A') ? 'B' : 'A');
    db.prepare(`UPDATE provider_credentials SET ciphertext = ? WHERE company_id = 'leumi'`).run(tampered);

    expect(readCredentials(db)).toEqual([]);
    expect(listCredentials(db)).toEqual([]);
  });
});

describe('scrubSecrets', () => {
  it('removes a credential value a bank echoed back in its error text', () => {
    const secrets = Object.values(LOGIN);
    const message = `Login failed for demo-user: the password demo-pass-123 is wrong`;
    expect(scrubSecrets(secrets, message)).toBe('Login failed for ***: the password *** is wrong');
  });

  it('leaves text without a credential in it alone, and tolerates no text at all', () => {
    expect(scrubSecrets(Object.values(LOGIN), 'TIMEOUT')).toBe('TIMEOUT');
    expect(scrubSecrets(Object.values(LOGIN), undefined)).toBe('');
  });
});

describe('resetHousehold', () => {
  it('leaves an empty household that still works', () => {
    const db = testDb();
    addAccount(db, 'bank:1', 'bank');
    addTx(db, { account: 'bank:1', date: '2026-09-03', description: 'סופר', amount: -100, kind: 'expense' });

    resetHousehold(db);

    expect(db.prepare(`SELECT COUNT(*) FROM transactions`).pluck().get()).toBe(0);
    // only `manual:entries`, which migration 10 puts in every fresh database — nothing scraped
    expect(db.prepare(`SELECT id FROM accounts`).pluck().all()).toEqual([MANUAL_ACCOUNT_ID]);
    // the migrations ran again, so a fresh household's defaults are back
    expect(db.prepare(`SELECT COUNT(*) FROM members`).pluck().get()).toBeGreaterThan(0);
    expect(db.prepare(`SELECT COUNT(*) FROM categories`).pluck().get()).toBeGreaterThan(0);

    addAccount(db, 'bank:1', 'bank');
    const id = addTx(db, { account: 'bank:1', date: '2026-09-04', description: 'דלק', amount: -200, kind: 'expense' });
    expect(id).toBeGreaterThan(0);
  });
});
