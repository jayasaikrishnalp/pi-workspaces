-- Migration 005: workflow runs.
-- A run is a single execution of a workflow's steps[]; step rows track each step's
-- status + output. Sequential v1 — no parallelism, no branching.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           TEXT    PRIMARY KEY,
  workflow     TEXT    NOT NULL,
  status       TEXT    NOT NULL,             -- queued | running | completed | failed | cancelled
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  triggered_by TEXT,                          -- 'operator' | 'agent' | 'cron'
  step_count   INTEGER NOT NULL DEFAULT 0,
  step_done    INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_started
  ON workflow_runs(workflow, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  run_id      TEXT    NOT NULL,
  step_index  INTEGER NOT NULL,
  step_kind   TEXT    NOT NULL,              -- 'skill' | 'workflow'
  step_ref    TEXT    NOT NULL,
  status      TEXT    NOT NULL,              -- queued | running | completed | failed | skipped
  started_at  INTEGER,
  ended_at    INTEGER,
  output      TEXT,                           -- truncated to 4KB by writer
  error       TEXT,
  PRIMARY KEY (run_id, step_index),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wf_step_runs_run ON workflow_step_runs(run_id);
