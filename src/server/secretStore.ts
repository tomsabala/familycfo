import { chmodSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { DB } from '../db/connection.js';
import type { Config } from '../scraper.js';

/**
 * Bank logins a visitor typed into the hosted app. Same shape as Resume-Matcher's key store on this
 * gateway (apps/backend/app/crypto.py): ciphertext in the instance's own database, the symmetric key
 * in a 0600 file next to it, plaintext only in memory while a scrape runs. For an anonymous visitor
 * both live on the container's tmpfs, so both die with the container; for the admin instance both
 * live on its named volume, and `docker volume rm` is the eraser.
 */
const keyFile = () => join(dirname(resolve(process.env.BANK_DB || 'bank.db')), '.secret_key');

const KEY_BYTES = 32;

export interface StoredCredential {
  companyId: string;
  hint: string | null;
  updatedAt: string;
}

/**
 * The container's symmetric key. Created on first use, exclusively, so two simultaneous first
 * writes cannot clobber one another. A key of the wrong length is unusable: every ciphertext under
 * it is unrecoverable by construction, so it is replaced and the rows are dropped in the same call.
 */
function loadKey(db?: DB): Buffer {
  const file = keyFile();
  for (;;) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8').trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const fresh = randomBytes(KEY_BYTES);
      try {
        writeFileSync(file, fresh.toString('base64'), { mode: 0o600, flag: 'wx' });
        return fresh;
      } catch (writeErr) {
        if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') throw writeErr;
        continue; // someone else won the race — read theirs
      }
    }
    chmodSync(file, 0o600);
    const key = Buffer.from(raw, 'base64');
    if (key.length === KEY_BYTES) return key;
    db?.prepare(`DELETE FROM provider_credentials`).run();
    rmSync(file, { force: true });
  }
}

/** AES-256-GCM. `v1:<iv>:<tag>:<ciphertext>`, each part base64url. */
export function encrypt(plain: string, key = loadKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

/** `null` on anything that does not decrypt: a wrong key, a truncated row, a tampered one. */
export function decrypt(text: string, key = loadKey()): string | null {
  try {
    const [version, iv, tag, ct] = text.split(':');
    if (version !== 'v1' || !iv || !tag || !ct) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

/** The last 4 characters of the first non-password field — all the UI ever shows of a login. */
function hintOf(fields: Record<string, string>): string | null {
  const value = Object.entries(fields).find(([name]) => name !== 'password')?.[1];
  return value ? value.slice(-4) : null;
}

export function saveCredentials(db: DB, companyId: string, fields: Record<string, string>): void {
  const key = loadKey(db);
  db.prepare(`
    INSERT INTO provider_credentials (company_id, ciphertext, hint, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at
  `).run(companyId, encrypt(JSON.stringify(fields), key), hintOf(fields), new Date().toISOString());
}

/** What the UI is allowed to know: which providers are connected, and when. Never a field value. */
export function listCredentials(db: DB): StoredCredential[] {
  return (db.prepare(`SELECT company_id, hint, updated_at FROM provider_credentials ORDER BY company_id`)
    .all() as { company_id: string; hint: string | null; updated_at: string }[])
    .map(r => ({ companyId: r.company_id, hint: r.hint, updatedAt: r.updated_at }));
}

export function countCredentials(db: DB): number {
  return db.prepare(`SELECT COUNT(*) FROM provider_credentials`).pluck().get() as number;
}

/**
 * The only function that returns plaintext; the scrape job is its only caller. A row that no longer
 * decrypts is dropped here — it can never be used again, and leaving it would show the visitor a
 * provider that cannot log in.
 */
export function readCredentials(db: DB): { companyId: string; credentials: Record<string, string> }[] {
  const key = loadKey(db);
  const out: { companyId: string; credentials: Record<string, string> }[] = [];
  for (const row of db.prepare(`SELECT company_id, ciphertext FROM provider_credentials ORDER BY company_id`)
    .all() as { company_id: string; ciphertext: string }[]) {
    const plain = decrypt(row.ciphertext, key);
    const fields = plain === null ? null : (JSON.parse(plain) as Record<string, string>);
    if (!fields) {
      db.prepare(`DELETE FROM provider_credentials WHERE company_id = ?`).run(row.company_id);
      continue;
    }
    out.push({ companyId: row.company_id, credentials: fields });
  }
  return out;
}

export function deleteCredentials(db: DB, companyId: string): void {
  db.prepare(`DELETE FROM provider_credentials WHERE company_id = ?`).run(companyId);
}

/** Erase everything: the rows and the key they were encrypted under. */
export function clearCredentials(db: DB): void {
  db.prepare(`DELETE FROM provider_credentials`).run();
  rmSync(keyFile(), { force: true });
}

/** The scrape config built from what the visitor typed in, instead of the operator's accounts.json. */
export function storedConfig(db: DB): Config {
  const accounts = readCredentials(db);
  if (accounts.length === 0) {
    throw Object.assign(new Error('לא חובר עדיין חשבון בנק'), { statusCode: 400 });
  }
  return { accounts: accounts as Config['accounts'] };
}
