import type { DB } from './connection.js';
import { runMigrations } from './migrate.js';

/** Start over: every table dropped and rebuilt by the migrations, on the same open connection, so
 *  the routes that captured `db` keep working. The rebuilt database is byte-for-byte the "new
 *  database" path the migrations already take on first open. */
export function resetHousehold(db: DB): void {
  db.pragma('foreign_keys = OFF');
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  ).pluck().all() as string[];
  db.transaction(() => { for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`); })();
  runMigrations(db);   // recreates schema_version too, so every migration runs from 1
  db.pragma('foreign_keys = ON');
}
