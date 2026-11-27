# CORE-03 — Intelligence Engine

## 1. Purpose

CORE-03 adds the **agent intelligence layer** on top of the merged CORE-02
command/capability engine. It turns plain-language outcomes into structured,
inspectable plans and governed execution, bound to the existing CORE-02 security
model (action passports, risk classes R0–R4, audit hash chain, idempotency).

The layer is **provider-agnostic**: no hardcoded AI vendor. A model-provider
abstraction defines provider-neutral contracts, and multi-provider routing
selects and falls back across providers while respecting privacy classification.

Honest status is a hard rule. Provider registration is not availability;
availability is derived from configuration and health. No fabricated execution
occurs: the orchestrator executes only through the CORE-02 gateway and never
auto-approves consequential actions.

## 2. Components

### CORE-03A — Foundation
- `lib/ai/types.ts` — shared type foundation (providers, models, requests,
  responses, streaming, routing, intent, plans, agents, conversations).
- `lib/ai/provider-registry.ts` / `lib/ai/model-registry.ts` — registry services
  persisting provider/model definitions to SQLite. Provider secrets are never
  stored in ordinary records and never returned to the browser.
- `lib/ai/config.ts` — env-based provider config; credentials referenced by env
  NAME, never stored/returned.
- `lib/ai/providers/test-provider.ts` — deterministic `TestProviderAdapter`
  (no real provider). Supplies valid structured intent/plan output so the full
  pipeline is exercisable without a real model.
- `lib/ai/routing.ts` — `ModelRouter` model selection + fallback chain,
  privacy-respecting, fail-closed.
- `lib/ai/bootstrap.ts` — registers default providers/models (test AVAILABLE;
  env providers CONFIGURATION_REQUIRED) and the minimum genuine system agent.
- `lib/ai/conversation.ts` — `ConversationService` workspace+user-scoped
  conversations/messages/usage.

### CORE-03B — Intent + Context
- `lib/ai/intent.ts` — `IntentEngine.recognise()`. Validates untrusted model
  output against a strict Zod schema (fail-closed). Surfaces ambiguity for
  important values. Heuristic Tamil/Tanglish/English language detection.
- `lib/ai/context.ts` — `ContextAssembler.assemble()`. Permission-aware minimal
  context bundle (workspace metadata, command catalogue, capabilities, models,
  token estimate + budget trim, sources).

### CORE-03C — Planning
- `lib/ai/planning.ts` — `PlanningEngine.propose()`. Converts intent → validated
  inspectable plan. Fail-closed on unknown command ids
  (`UNKNOWN_COMMAND_IN_PLAN`). Persists to the `plans` table. Never executes.

### CORE-03D — Agent Registry
- `lib/ai/agents.ts` — `AgentRegistry`. Typed runtime registration; rejects
  unknown command refs and invalid schemas; `canAcceptTask`;
  `validateDelegationScope` (agents cannot expand caller authority).
- Registers the minimum genuine system-level orchestrator agent
  (`bean.system.orchestrator`). The 117-agent workforce archive (DOC-02) remains
  incomplete and is **not** fabricated.

### CORE-03E — Orchestration
- `lib/ai/orchestrator.ts` — `AgentOrchestrator.handleTurn()`. Recognises
  intent → assembles context → proposes plan → executes **only R0/R1
  approval-free** commands via `CommandGateway.submit()`. Consequential commands
  are left AWAITING_APPROVAL (never auto-approved). Bounded delegation
  (`MAX_DELEGATION_DEPTH=3`, `MAX_ACTIVE_AGENTS_PER_TASK=4`, `MAX_SUBTASKS=8`,
  `MAX_MODEL_CALLS=12`). `validateAgentResult()` reconciles passports/evidence.

### CORE-03F — API + UI
- `app/api/ai/providers/route.ts` — provider discovery (non-secret).
- `app/api/ai/conversations/` + `[id]/` + `[id]/messages/` — conversation CRUD.
- `app/api/ai/chat/route.ts` — NDJSON stream: meta/delta/plan/execution/
  complete/error; persists user+assistant messages; never exposes provider
  secrets or chain-of-thought.
- `app/api/ai/intent/route.ts`, `app/api/ai/plan/route.ts` — intent/plan probes.
- `app/api/ai/agents/route.ts` — registered-agent listing.
- `app/chat/page.tsx` — wired to the real streaming chat backend, conversation
  history, plan panel and execution receipts.

## 3. CORE-02 reuse (no second system)

CORE-03 does not reimplement execution or authorisation. It binds to the
CORE-02 `CommandGateway.submit()` (BLOCKED/fail-closed), action passports, risk
classes R0–R4, the audit hash chain and Gate B canonical-payload idempotency.
The orchestrator only reads resolved permissions from the CORE-01 policy engine
(deny-by-default); it never grants authority.

## 4. Fail-closed behaviour

- Untrusted model output is validated against strict Zod schemas before use
  (`INVALID_INTENT_OUTPUT`, `INVALID_PLAN_OUTPUT`).
- Plans referencing unknown command ids are rejected (`UNKNOWN_COMMAND_IN_PLAN`).
- No available model → honest error, never a fabricated result
  (`NO_MODEL_AVAILABLE`, `NO_PROVIDER_ADAPTER`).
- Consequential (R2+) commands are never auto-executed; they await human approval.
- Agent results are validated against the delegation envelope (passport/evidence
  reconciliation); unauthorised or unverified claims are rejected.

## 5. Provider abstraction contract

`AIProviderAdapter` = `{ describe, listModels, healthCheck, generate, stream,
cancel? }`. `generate()` is async and returns
`{ content, structured, usage, providerMetadata, error? }`. Provider
registration ≠ availability; availability is derived from configuration + health.
Env-configured providers are registered `CONFIGURATION_REQUIRED` with a no-op
adapter that throws on generate/stream — never pretend-connected.

## 6. Status vocabulary

Engine: DESIGNED/IMPLEMENTED/TESTED/REGISTERED/CONFIGURED/AVAILABLE/CONNECTED/
VERIFIED/DEPLOYED. Provider availability: PLANNED/REGISTERED/CONFIGURATION_REQUIRED/
AVAILABLE/DEGRADED/UNAVAILABLE/DISABLED/REVOKED.

## 7. Verification

- `npx tsc --noEmit` — clean.
- `npx next lint` — clean.
- `npx vitest run` — all tests pass (CORE-03 engine + route suites added).
- `npx next build` — clean.
- CORE-03 engine tests (`tests/core03-engine.test.ts`): intent fail-closed
  validation, language detection, planning fail-closed on unknown commands,
  agent-registry scope validation, orchestrator R0/R1-only execution, no
  auto-approval of consequential commands, bounded delegation.
- CORE-03 route tests (`tests/core03-routes.test.ts`): provider discovery
  (no secrets), conversation CRUD, chat NDJSON streaming + persistence,
  auth/403/400 enforcement.

## 8. Explicitly out of scope

- The 117-agent workforce archive (DOC-02) — incomplete; not fabricated.
- Real AI provider SDKs/contracts — provider abstraction + deterministic test
  provider only. Real adapters arrive when a contract exists.
- Any auto-approval of consequential (R2+) actions — always human-gated.
