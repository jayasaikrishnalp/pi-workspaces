-- Migration 006: workflow runs v2 — agent-driven, branching pipelines.
--
-- Additive only: keeps step_kind / step_ref columns from 005 working
-- (new agent-driven rows write step_kind = 'agent' and step_ref = agent_id
-- so any reader still sees a valid value). The new columns capture the
-- richer YAML schema: stable step ids, agent prompts, branch routing,
-- decision tokens, and the pi run id used to drive each step.

ALTER TABLE workflow_step_runs ADD COLUMN step_id        TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN step_agent_id  TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN step_note      TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN step_branches  TEXT;  -- JSON {decision: stepId}
ALTER TABLE workflow_step_runs ADD COLUMN step_decision  TEXT;  -- decision token observed
ALTER TABLE workflow_step_runs ADD COLUMN step_next      TEXT;  -- the step id we routed to
ALTER TABLE workflow_step_runs ADD COLUMN pi_run_id      TEXT;  -- bridge runId for this step

CREATE INDEX IF NOT EXISTS idx_wf_step_runs_agent ON workflow_step_runs(step_agent_id);

-- Workflow-level metadata for v2 runs. Older v1 rows have name = workflow.
ALTER TABLE workflow_runs ADD COLUMN workflow_name TEXT;
