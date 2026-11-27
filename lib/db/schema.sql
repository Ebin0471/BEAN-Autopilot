-- CORE-01 relational schema (portable SQL; dev/test on SQLite, production target PostgreSQL).
-- Timestamps are stored as ISO-8601 UTC TEXT for portability across providers.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | SUSPENDED | DELETED
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- Email is a profile attribute only, NOT an identity key. Accounts are keyed by
-- (provider, provider_user_id); two distinct provider identities may share an email.
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_accounts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,                 -- e.g. "oidc", "local-dev"
  provider_user_id TEXT NOT NULL,                -- stable provider identity (never email alone)
  created_at      TEXT NOT NULL,
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_auth_accounts_user ON auth_accounts(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_label  TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('PERSONAL','PROFESSIONAL','BUSINESS')),
  name          TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','OPERATOR','MEMBER','VIEWER')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON workspace_memberships(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invitee_email TEXT NOT NULL,
  role          TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | ACCEPTED | REVOKED
  created_at    TEXT NOT NULL,
  accepted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON invitations(workspace_id);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT,
  created_at    TEXT NOT NULL
);

-- Global role -> permission default mapping (deny-by-default; unknown permissions denied).
CREATE TABLE IF NOT EXISTS role_permissions (
  role       TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','OPERATOR','MEMBER','VIEWER')),
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE IF NOT EXISTS action_passports (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  initiator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id          TEXT,
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('USER','AGENT')),
  target_type       TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  command           TEXT NOT NULL,
  operation         TEXT NOT NULL,
  data_scope        TEXT NOT NULL,
  permission_scope  TEXT NOT NULL,               -- JSON array
  risk_class        TEXT NOT NULL CHECK (risk_class IN ('R0','R1','R2','R3','R4')),
  param_hash        TEXT NOT NULL,
  params_canonical  TEXT NOT NULL DEFAULT '{}',     -- canonical full payload (CORE-02)
  approval_policy   TEXT NOT NULL DEFAULT 'NONE', -- NONE | SINGLE | DUAL
  status            TEXT NOT NULL DEFAULT 'REQUESTED',
  idempotency_key   TEXT NOT NULL,
  verification_req  TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  consumed_at       TEXT,
  revoked_at        TEXT,
  audit_ref         TEXT,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_passports_workspace ON action_passports(workspace_id);
CREATE INDEX IF NOT EXISTS idx_passports_status ON action_passports(status);

CREATE TABLE IF NOT EXISTS passport_approvals (
  id          TEXT PRIMARY KEY,
  passport_id TEXT NOT NULL REFERENCES action_passports(id) ON DELETE CASCADE,
  approver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision    TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  comment     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_passport ON passport_approvals(passport_id);

-- Append-only audit log with hash chaining (prev_hash -> event_hash).
CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  result        TEXT NOT NULL,                   -- SUCCESS | DENIED | FAILURE
  metadata      TEXT NOT NULL DEFAULT '{}',      -- JSON (redacted)
  prev_hash     TEXT,
  event_hash    TEXT NOT NULL,
  request_id    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_events(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);

CREATE TABLE IF NOT EXISTS workspace_policies (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_key    TEXT NOT NULL,
  policy_value  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, policy_key)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, key)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ============================================================
-- CORE-02: universal command registry, capability fabric and
-- command execution lifecycle. Portable SQL (SQLite dev/test,
-- PostgreSQL production target). Non-destructive additions.
-- ============================================================

CREATE TABLE IF NOT EXISTS commands (
  command_id            TEXT NOT NULL,
  version               TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL,
  category              TEXT NOT NULL,
  required_capability   TEXT,
  required_permissions  TEXT NOT NULL,            -- JSON array
  server_risk_class     TEXT NOT NULL CHECK (server_risk_class IN ('R0','R1','R2','R3','R4')),
  approval_policy       TEXT NOT NULL,
  execution_mode        TEXT NOT NULL,
  target_requirements   TEXT NOT NULL,            -- JSON
  timeout_policy        TEXT NOT NULL,            -- JSON
  rate_limit_policy     TEXT NOT NULL,            -- JSON
  idempotency_policy    TEXT NOT NULL,            -- JSON
  verification_contract TEXT NOT NULL,            -- JSON
  compensation_contract TEXT NOT NULL,            -- JSON
  availability_reqs     TEXT NOT NULL DEFAULT '[]',-- JSON array
  deprecation_status    TEXT NOT NULL DEFAULT 'ACTIVE',
  documentation         TEXT NOT NULL,
  registered_by         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (command_id, version)
);

CREATE TABLE IF NOT EXISTS capabilities (
  capability_id          TEXT NOT NULL,
  version                TEXT NOT NULL,
  name                   TEXT NOT NULL,
  category               TEXT NOT NULL,
  provider               TEXT NOT NULL,
  description            TEXT NOT NULL,
  supported_commands     TEXT NOT NULL DEFAULT '[]',-- JSON array
  required_scopes        TEXT NOT NULL DEFAULT '[]',-- JSON array
  supported_workspace_types TEXT NOT NULL DEFAULT '[]',-- JSON array
  risk_constraints       TEXT NOT NULL DEFAULT '[]',-- JSON array
  availability_status    TEXT NOT NULL,
  health_status          TEXT NOT NULL DEFAULT 'UNKNOWN',
  connection_requirements TEXT NOT NULL DEFAULT '[]',-- JSON array
  rate_limits            TEXT NOT NULL,            -- JSON
  timeout_limits         TEXT NOT NULL,            -- JSON
  verification_support   INTEGER NOT NULL DEFAULT 0,
  compensation_support   INTEGER NOT NULL DEFAULT 0,
  documentation          TEXT NOT NULL,
  trust_level            TEXT NOT NULL,
  registered_by          TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (capability_id, version)
);

-- Command execution lifecycle records (accepted, blocked, pending, executing, verified, failed).
CREATE TABLE IF NOT EXISTS command_executions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id        TEXT NOT NULL,
  command_version   TEXT NOT NULL,
  capability_id     TEXT,
  passport_id       TEXT,
  target_type       TEXT,
  target_id         TEXT,
  params_hash       TEXT NOT NULL,
  status            TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  adapter_id        TEXT,
  result            TEXT,
  evidence          TEXT,
  error_code        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_exec_workspace ON command_executions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_exec_status ON command_executions(status);


-- ============================================================
-- CORE-03 — AI INTELLIGENCE LAYER
-- Provider-neutral AI: providers, models, conversations,
-- messages, plans, agent tasks and usage. No provider secrets
-- are stored in ordinary records; credentials are referenced.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_providers (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL UNIQUE,
  provider_name     TEXT NOT NULL,
  version           TEXT NOT NULL,
  adapter_type      TEXT NOT NULL,            -- native | openai-compatible | local | test
  endpoint_ref      TEXT,                      -- reference to config, never a secret
  auth_ref          TEXT,                      -- reference to credential config, never a secret
  supported_modalities TEXT NOT NULL DEFAULT '[]',  -- JSON array
  streaming_supported INTEGER NOT NULL DEFAULT 0,
  structured_output_supported INTEGER NOT NULL DEFAULT 0,
  structured_output_mode  TEXT NOT NULL DEFAULT 'NONE',   -- NONE | PROMPTED_JSON | NATIVE_JSON_SCHEMA
  tool_call_supported INTEGER NOT NULL DEFAULT 0,
  context_window    INTEGER,
  rate_limit_json   TEXT,                      -- JSON metadata
  privacy_class     TEXT NOT NULL DEFAULT 'INTERNAL', -- INTERNAL | LOCAL | EXTERNAL
  availability_status TEXT NOT NULL DEFAULT 'PLANNED', -- PLANNED|REGISTERED|CONFIGURATION_REQUIRED|AVAILABLE|DEGRADED|UNAVAILABLE|DISABLED|REVOKED
  health_status     TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_providers_status ON ai_providers(availability_status);

CREATE TABLE IF NOT EXISTS ai_models (
  id                TEXT PRIMARY KEY,
  model_id          TEXT NOT NULL UNIQUE,
  provider_id       TEXT NOT NULL REFERENCES ai_providers(provider_id) ON DELETE CASCADE,
  model_name        TEXT NOT NULL,
  model_version     TEXT NOT NULL,
  supported_tasks   TEXT NOT NULL DEFAULT '[]',   -- JSON array of task categories
  supported_modalities TEXT NOT NULL DEFAULT '[]',
  max_context_tokens INTEGER,
  max_output_tokens  INTEGER,
  structured_output INTEGER NOT NULL DEFAULT 0,
  structured_output_mode TEXT NOT NULL DEFAULT 'NONE',   -- NONE | PROMPTED_JSON | NATIVE_JSON_SCHEMA
  tool_call         INTEGER NOT NULL DEFAULT 0,
  streaming         INTEGER NOT NULL DEFAULT 0,
  reasoning         INTEGER NOT NULL DEFAULT 0,
  latency_metadata  TEXT,
  cost_metadata     TEXT,
  privacy_class     TEXT NOT NULL DEFAULT 'INTERNAL',
  status            TEXT NOT NULL DEFAULT 'REGISTERED', -- REGISTERED | AVAILABLE | DISABLED
  availability_evidence TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_models_status ON ai_models(status);

CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ARCHIVED | DELETED
  selected_model_id TEXT,
  selected_provider_id TEXT,
  routing_mode      TEXT NOT NULL DEFAULT 'AUTO',   -- AUTO | MANUAL
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (workspace_id, user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content           TEXT NOT NULL,
  content_json      TEXT,                          -- structured payload (plan, tool calls, etc.)
  model_id          TEXT,
  provider_id       TEXT,
  token_usage_json  TEXT,                          -- JSON {input,output,cached}
  status            TEXT NOT NULL DEFAULT 'COMPLETED', -- PENDING|STREAMING|COMPLETED|FAILED|CANCELLED
  error_code        TEXT,
  created_at        TEXT NOT NULL,
  seq               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS plans (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  objective         TEXT NOT NULL,
  plan_json         TEXT NOT NULL,                 -- full structured plan
  risk_class        TEXT NOT NULL DEFAULT 'R1',
  status            TEXT NOT NULL DEFAULT 'PROPOSED', -- PROPOSED|VALIDATED|AWAITING_APPROVAL|APPROVED|EXECUTING|COMPLETED|VERIFIED|FAILED|PARTIAL
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_conversation ON plans(conversation_id);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id                TEXT PRIMARY KEY,
  plan_id           TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_task_id    TEXT,
  agent_id          TEXT NOT NULL,
  objective         TEXT NOT NULL,
  allowed_commands  TEXT NOT NULL DEFAULT '[]',    -- JSON array
  permission_scope  TEXT NOT NULL DEFAULT '[]',    -- JSON array
  risk_ceiling      TEXT NOT NULL DEFAULT 'R2',
  status            TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED|RUNNING|AWAITING_APPROVAL|COMPLETED|FAILED|CANCELLED
  result_json       TEXT,
  depth             INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_plan ON agent_tasks(plan_id);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id       TEXT,
  model_id          TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  request_count     INTEGER NOT NULL DEFAULT 1,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  estimated_cost_json TEXT,
  conversation_id   TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_workspace ON ai_usage(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  version           TEXT NOT NULL,
  description       TEXT NOT NULL,
  category          TEXT NOT NULL,
  supported_workspace_types TEXT NOT NULL DEFAULT '[]',
  allowed_command_ids TEXT NOT NULL DEFAULT '[]',
  required_permissions TEXT NOT NULL DEFAULT '[]',
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  input_schema      TEXT NOT NULL DEFAULT '{}',
  output_schema     TEXT NOT NULL DEFAULT '{}',
  risk_constraints  TEXT NOT NULL DEFAULT '[]',
  delegation_policy TEXT NOT NULL DEFAULT 'NONE',
  maximum_steps     INTEGER NOT NULL DEFAULT 1,
  timeout_seconds   INTEGER NOT NULL DEFAULT 60,
  token_budget      INTEGER,
  verification_requirements TEXT NOT NULL DEFAULT '[]',
  escalation_rules  TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);


-- CORE-03G: workspace-scoped external-AI data-processing consent.
-- Additive. Default: external processing disabled. Only an authorised owner
-- or a role holding the AI-consent policy permission may change it.
CREATE TABLE IF NOT EXISTS workspace_ai_consent (
  workspace_id            TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  external_ai_allowed     INTEGER NOT NULL DEFAULT 0,
  allowed_external_provider_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of provider ids
  consent_version         TEXT NOT NULL DEFAULT '1',
  consented_by            TEXT,
  consented_at            TEXT,
  updated_at              TEXT NOT NULL,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_ai_consent_workspace ON workspace_ai_consent(workspace_id);
