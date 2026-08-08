/**
 * Schema migrations, applied in order and tracked in `schema_migrations`.
 *
 * Inlined as strings rather than .sql files so the compiled `dist/` needs no
 * asset-copy step in the Docker build.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: /* sql */ `
      CREATE TABLE jobs (
        id                  TEXT PRIMARY KEY,
        pipeline            TEXT NOT NULL,
        params              TEXT NOT NULL,          -- JSON; never holds image bytes
        input_path          TEXT,
        input_sha256        TEXT,
        input_bytes         INTEGER,
        state               TEXT NOT NULL,
        progress            REAL NOT NULL DEFAULT 0,
        error               TEXT,
        artifacts           TEXT NOT NULL DEFAULT '[]',
        pod_id              TEXT,
        lease_id            TEXT,
        lease_expires_at    INTEGER,
        upstream_id         TEXT,
        attempts            INTEGER NOT NULL DEFAULT 0,
        cancel_requested    INTEGER NOT NULL DEFAULT 0,
        cancel_requested_at INTEGER,
        created_at          INTEGER NOT NULL,
        started_at          INTEGER,
        finished_at         INTEGER,
        deadline_at         INTEGER NOT NULL
      );
      CREATE INDEX idx_jobs_state_created ON jobs(state, created_at);
      CREATE INDEX idx_jobs_pod           ON jobs(pod_id, state);
      CREATE INDEX idx_jobs_finished      ON jobs(finished_at);
      CREATE INDEX idx_jobs_lease         ON jobs(state, lease_expires_at);

      -- The pod registry is DB-backed rather than in-memory so a gateway
      -- restart does not lose track of which pods are alive and busy.
      CREATE TABLE pods (
        pod_id          TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        first_seen_at   INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL,
        agent_version   TEXT,
        model_path      TEXT,
        lora_path       TEXT,
        pipelines       TEXT NOT NULL DEFAULT '[]',
        gpu             TEXT,
        max_in_flight   INTEGER NOT NULL DEFAULT 1,
        sglang_ready    INTEGER NOT NULL DEFAULT 0,
        draining        INTEGER NOT NULL DEFAULT 0,
        jobs_completed  INTEGER NOT NULL DEFAULT 0,
        jobs_failed     INTEGER NOT NULL DEFAULT 0
      );

      -- Append-only audit trail. Earns its keep the first time someone asks
      -- why a particular job took fourteen minutes.
      CREATE TABLE job_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id  TEXT NOT NULL,
        ts      INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        pod_id  TEXT,
        detail  TEXT
      );
      CREATE INDEX idx_events_job ON job_events(job_id, ts);
    `,
  },
];
