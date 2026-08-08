/**
 * The pod registry.
 *
 * Kept in SQLite rather than an in-memory Map so a gateway restart doesn't
 * forget which pods exist and what they're capable of. Liveness is derived from
 * `last_seen_at` (updated on every agent poll) rather than from a held
 * connection — with long-polling there is no connection to hold.
 */
import type { Db } from './sqlite.js';
import type { Pod } from '../domain/types.js';

interface PodRow {
  pod_id: string;
  session_id: string;
  first_seen_at: number;
  last_seen_at: number;
  agent_version: string | null;
  model_path: string | null;
  lora_path: string | null;
  pipelines: string;
  gpu: string | null;
  max_in_flight: number;
  sglang_ready: number;
  draining: number;
  jobs_completed: number;
  jobs_failed: number;
}

function hydrate(row: PodRow): Pod {
  return {
    pod_id: row.pod_id,
    session_id: row.session_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    agent_version: row.agent_version,
    model_path: row.model_path,
    lora_path: row.lora_path,
    pipelines: JSON.parse(row.pipelines) as string[],
    gpu: row.gpu,
    max_in_flight: row.max_in_flight,
    sglang_ready: row.sglang_ready === 1,
    draining: row.draining === 1,
    jobs_completed: row.jobs_completed,
    jobs_failed: row.jobs_failed,
  };
}

export interface PodHeartbeat {
  pod_id: string;
  session_id: string;
  agent_version: string | null;
  model_path: string | null;
  lora_path: string | null;
  pipelines: string[];
  gpu: string | null;
  max_in_flight: number;
  sglang_ready: boolean;
}

export class PodStore {
  constructor(private readonly db: Db) {}

  /** Upsert on every poll. `first_seen_at` and the counters survive. */
  touch(hb: PodHeartbeat, now: number): Pod {
    this.db
      .prepare(
        `INSERT INTO pods (pod_id, session_id, first_seen_at, last_seen_at, agent_version,
                           model_path, lora_path, pipelines, gpu, max_in_flight, sglang_ready)
         VALUES (@pod_id, @session_id, @now, @now, @agent_version,
                 @model_path, @lora_path, @pipelines, @gpu, @max_in_flight, @sglang_ready)
         ON CONFLICT(pod_id) DO UPDATE SET
           -- session_id is assigned once and kept: it identifies the pod's
           -- registration, not the individual poll.
           last_seen_at  = excluded.last_seen_at,
           agent_version = excluded.agent_version,
           model_path    = excluded.model_path,
           lora_path     = excluded.lora_path,
           pipelines     = excluded.pipelines,
           gpu           = excluded.gpu,
           max_in_flight = excluded.max_in_flight,
           sglang_ready  = excluded.sglang_ready`,
      )
      .run({
        pod_id: hb.pod_id,
        session_id: hb.session_id,
        now,
        agent_version: hb.agent_version,
        model_path: hb.model_path,
        lora_path: hb.lora_path,
        pipelines: JSON.stringify(hb.pipelines),
        gpu: hb.gpu,
        max_in_flight: hb.max_in_flight,
        sglang_ready: hb.sglang_ready ? 1 : 0,
      });
    return this.get(hb.pod_id)!;
  }

  get(podId: string): Pod | null {
    const row = this.db.prepare('SELECT * FROM pods WHERE pod_id = ?').get(podId) as
      | PodRow
      | undefined;
    return row ? hydrate(row) : null;
  }

  list(): Pod[] {
    const rows = this.db
      .prepare('SELECT * FROM pods ORDER BY last_seen_at DESC')
      .all() as PodRow[];
    return rows.map(hydrate);
  }

  /** Pods that polled recently enough to still count as capacity. */
  listConnected(since: number): Pod[] {
    const rows = this.db
      .prepare('SELECT * FROM pods WHERE last_seen_at >= ? ORDER BY last_seen_at DESC')
      .all(since) as PodRow[];
    return rows.map(hydrate);
  }

  setDraining(podId: string, draining: boolean): boolean {
    return (
      this.db
        .prepare('UPDATE pods SET draining = ? WHERE pod_id = ?')
        .run(draining ? 1 : 0, podId).changes === 1
    );
  }

  recordOutcome(podId: string | null, outcome: 'completed' | 'failed'): void {
    if (!podId) return;
    const column = outcome === 'completed' ? 'jobs_completed' : 'jobs_failed';
    this.db.prepare(`UPDATE pods SET ${column} = ${column} + 1 WHERE pod_id = ?`).run(podId);
  }

  /** Forget pods that haven't polled in a long time, so /v1/pods stays readable. */
  purgeBefore(before: number): number {
    return this.db.prepare('DELETE FROM pods WHERE last_seen_at < ?').run(before).changes;
  }
}
