/**
 * SQLite connection + migration runner.
 *
 * `better-sqlite3` is deliberately synchronous: every state transition in the
 * scheduler is a compare-and-swap, and a synchronous CAS on a single-threaded
 * event loop has no interleavings to reason about. That property is what makes
 * lease fencing (see db/jobs.ts) trivially correct.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  // WAL lets the reaper and cleanup sweeps run without blocking request reads.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
  )`);

  const applied = new Set<number>(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => (row as { id: number }).id),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, Date.now());
    })();
  }
}
