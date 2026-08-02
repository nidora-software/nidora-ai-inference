"""Job model and SQLite-backed job store.

Single connection guarded by a lock — accessed from API handlers and the worker
thread. All operations are sub-millisecond, so a lock is plenty.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any


class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_STATES = {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}


@dataclass
class Job:
    id: str
    pipeline: str
    params: dict[str, Any]
    state: JobState = JobState.QUEUED
    progress: float = 0.0
    error: str | None = None
    artifacts: list[dict[str, str]] = field(default_factory=list)
    created_at: str = ""
    started_at: str | None = None
    finished_at: str | None = None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_job_id() -> str:
    return f"j_{uuid.uuid4().hex[:12]}"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    pipeline    TEXT NOT NULL,
    params      TEXT NOT NULL,
    state       TEXT NOT NULL,
    progress    REAL NOT NULL DEFAULT 0,
    error       TEXT,
    artifacts   TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
"""


class JobStore:
    def __init__(self, db_path: Path | str):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def create(self, pipeline: str, params: dict[str, Any]) -> Job:
        job = Job(id=new_job_id(), pipeline=pipeline, params=params, created_at=_now())
        with self._lock:
            self._conn.execute(
                "INSERT INTO jobs (id, pipeline, params, state, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (job.id, job.pipeline, json.dumps(job.params), job.state, job.created_at),
            )
            self._conn.commit()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._to_job(row) if row else None

    def list(self, limit: int = 50) -> list[Job]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._to_job(r) for r in rows]

    def set_state(
        self,
        job_id: str,
        state: JobState,
        *,
        error: str | None = None,
        artifacts: list[dict[str, str]] | None = None,
        expect: JobState | None = None,
    ) -> bool:
        """Transition a job's state. If `expect` is given, acts as compare-and-swap
        and returns False when the current state doesn't match."""
        sets = ["state = ?"]
        args: list[Any] = [state]
        if state == JobState.RUNNING:
            sets.append("started_at = ?")
            args.append(_now())
        if state in TERMINAL_STATES:
            sets.append("finished_at = ?")
            args.append(_now())
        if error is not None:
            sets.append("error = ?")
            args.append(error)
        if artifacts is not None:
            sets.append("artifacts = ?")
            args.append(json.dumps(artifacts))
            sets.append("progress = 1.0")

        where = "id = ?"
        args.append(job_id)
        if expect is not None:
            where += " AND state = ?"
            args.append(expect)

        with self._lock:
            cur = self._conn.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE {where}", args)
            self._conn.commit()
        return cur.rowcount > 0

    def update_params(self, job_id: str, params: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET params = ? WHERE id = ?", (json.dumps(params), job_id)
            )
            self._conn.commit()

    def set_progress(self, job_id: str, progress: float) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET progress = ? WHERE id = ?", (min(max(progress, 0.0), 1.0), job_id)
            )
            self._conn.commit()

    def recover_on_startup(self) -> list[str]:
        """Mark jobs left `running` by a previous process as failed; return ids of
        `queued` jobs so the caller can re-enqueue them."""
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET state = ?, error = ?, finished_at = ? WHERE state = ?",
                (JobState.FAILED, "interrupted by server restart", _now(), JobState.RUNNING),
            )
            rows = self._conn.execute(
                "SELECT id FROM jobs WHERE state = ? ORDER BY created_at", (JobState.QUEUED,)
            ).fetchall()
            self._conn.commit()
        return [r["id"] for r in rows]

    def queue_depth(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM jobs WHERE state IN (?, ?)",
                (JobState.QUEUED, JobState.RUNNING),
            ).fetchone()
        return row["n"]

    @staticmethod
    def _to_job(row: sqlite3.Row) -> Job:
        return Job(
            id=row["id"],
            pipeline=row["pipeline"],
            params=json.loads(row["params"]),
            state=JobState(row["state"]),
            progress=row["progress"],
            error=row["error"],
            artifacts=json.loads(row["artifacts"]),
            created_at=row["created_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
        )
