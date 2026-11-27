# BEAN Autopilot — Milestone 1: Discovery, Current-State Map & Target Architecture

> Branch: `arena/efd799fd-bean-autopilot` (from `main` @ `4b090c7921aad70bca5dda1fdd99d1a1a2e3c31a`)
> Status: **Phase A — Discovery and architecture gap analysis. Owner decision received (documentation baseline approved). Documentation-only scope; no application source changes.**
> Date: 2026-11-27 (updated for owner decision on documentation baseline)
> This document is the first-milestone deliverable requested by the master build prompt. It contains **no code changes**; it is the assessment, schemas, matrix, audit and phased plan. The owner has approved the documentation baseline and authorised documentation import/publication; **Phase B has not begun** and remains blocked on the complete documentation package and explicit architecture/risk approval.

---

## 1. Repository assessment and current-state map

### 1.1 What actually exists (verified evidence)

| Item | Finding | Evidence |
|---|---|---|
| Tracked files | `LICENSE`, `README.md` only | `git ls-tree -r --name-only HEAD` |
| Working tree | Clean, no untracked files | `git status --short --branch` |
| Git history | **1 commit total**: `4b090c7` "Initial commit" | `git rev-list --count HEAD` |
| Branches | `main` and `arena/efd799fd-bean-autopilot` both point at the same single commit | `git for-each-ref` |
| Package manifests | **None** (no `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.) | `find . -path ./.git -prune -o -print` |
| Source code | **None** | same |
| Database schema | **None** | same |
| Tests | **None** | same |
| CI / deployment config | **None** | same |
| Environment examples | **None** | same |

`README.md` (281 bytes) is a single marketing sentence. `LICENSE` is **MIT**, Copyright (c) 2026 Ebin0471.

### 1.2 Current-state map

```
BEAN-Autopilot (repo @ 4b090c7)
│
├── LICENSE          MIT, © 2026 Ebin0471
└── README.md        one-line product description

[No blueprints/, governance/, agents/, src/, schema/, tests/, ci/, deploy/]
```

**Conclusion: this is a greenfield project.** There is no existing functionality, stack, integration contract, schema, test suite or configuration to preserve or build upon. Every "existing" artifact the master prompt tells me to inspect is absent.

### 1.3 Referenced inputs and import status (updated after owner decision)

The master prompt instructs me to read these files first. **Owner decision:** the complete BEAN Autopilot Universal Workforce package is the authoritative product and agent-governance baseline; the standalone mind map is **not** the only design document.

**Import blocker:** the supplied package `BEAN-AUTOPILOT-UNIVERSAL-WORKFORCE.zip` **was not present** in the workspace at execution time. Exhaustive verification found it nowhere:

- Filesystem search: no `.zip` or workforce package file exists (only the standalone `BEAN-AUTOPILOT-UNIVERSAL-MINDMAP.md` in `/tmp/arena-coding-uploads/`).
- Git object store: only the original README/LICENSE blobs; no hidden documentation objects.
- GitHub remote (`Ebin0471/BEAN-Autopilot`): only `main`, no releases, root tree is `LICENSE` + `README.md`; the package is not in the owner's other repositories.

Consequently, **0 of the 117 individual agent specifications and 0 of the supporting blueprint/governance/prompt documents have been imported.** They have **not** been fabricated: the non-fabrication rule prohibits inventing approved governance content or agent contracts.

The one legitimately supplied, owner-approved artifact — the mind map — **has been imported** under the canonical filename `BEAN-AUTOPILOT-MASTER-MINDMAP.md` (renamed from `BEAN-AUTOPILOT-UNIVERSAL-MINDMAP.md` with byte-identical content; no content lost).

> **Impact:** Because the governance and agent-contract files have not yet been imported, the Agent Registry schema (§3) and permission/risk matrix (§4) remain *proposed from the mindmap's own definitions* (risk classes R0–R4, Action Passport fields, universal action contract). They must be reconciled against the actual `governance/AGENT-EXECUTION-CONTRACT.md`, `governance/REPOSITORY-LICENSE-POLICY.md`, `blueprints/*` and the 117 `agents/**` contracts once the package is supplied. The full contradiction review requested by the owner is **blocked** on that import.

---

## 2. Proposed target architecture and data-flow

### 2.1 Design principles (from the mindmap)

- **Understand intent → discover capability → plan → authorise → execute → verify → recover → report.**
- One canonical command definition shared by **UI, CLI, JSON API and MCP**.
- **Least privilege**, no permission inheritance expansion during delegation.
- Untrusted data (webpages, files, emails, code, tool output) is never policy.
- Every consequential action carries an **Action Passport**; every execution yields a **receipt**.
- Workspace isolation: Personal + each Business tenant have separate data, memory, agents, credentials and audit trails.

### 2.2 Layered architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ENTRY SURFACES (thin adapters, all call the same Command Registry)      │
│  Web UI · CLI · JSON API · MCP server · (later) mobile / desktop / voice  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  canonical command + workspace + actor
┌───────────────────────────────▼─────────────────────────────────────────┐
│  ORCHESTRATOR                                                           │
│  intent parsing · task decomposition · routing · delegation ·           │
│  concurrency limits · handoff contracts · reconciliation of specialist  │
│  outputs · retry of safe failures                                       │
└───────┬───────────────────────────┬───────────────────────┬─────────────┘
        │                           │                       │
┌───────▼───────────┐      ┌────────▼────────┐      ┌───────▼──────────────┐
│ POLICY ENGINE     │      │ ACTION PASSPORT  │      │ DURABLE WORKFLOW     │
│ risk class        │◄────►│ issue/verify     │      │ engine               │
│ role & scope      │      │ actor·target·    │      │ idempotency·retries· │
│ approval gating   │      │ operation·expiry │      │ checkpoints·timeouts │
│ tenant isolation  │      │ ·verification   │      │ ·compensation·resume │
└───────┬───────────┘      └────────┬────────┘      └───────┬──────────────┘
        │                           │                       │
┌───────▼───────────────────────────▼───────────────────────▼─────────────┐
│  REGISTRY LAYER                                                        │
│  ┌──────────────────┐   ┌────────────────────────────────────────────┐ │
│  │ AGENT REGISTRY    │   │ COMMAND REGISTRY (canonical, versioned)   │ │
│  │ versioned contracts│   │ one definition → UI/CLI/API/MCP           │ │
│  │ skills·scopes·risk │   │ inputs/outputs·permission·verification   │ │
│  └──────────────────┘   └──────────────────┬─────────────────────────┘ │
└─────────────────────────────────────────────┼───────────────────────────┘
                                            │ execute registered command only
┌─────────────────────────────────────────────▼───────────────────────────┐
│  CAPABILITY FABRIC (connector SDK)                                       │
│  typed schemas · scopes · risk levels · prerequisites · verification     │
│  connectors: files · calendar · email · browser · finance · comms ...    │
└───────┬───────────────────────────────────────────────┬─────────────────┘
        │                                               │
┌───────▼──────────────────┐                ┌───────────▼──────────────────┐
│ MEMORY & KNOWLEDGE        │                │ VERIFICATION & RECOVERY      │
│ user-controlled, source-  │                │ verify real state from       │
│ linked, scoped, revocable │                │ authoritative sources ·      │
│ per-workspace            │                │ receipts · compensation      │
└──────────────────────────┘                └──────────────────────────────┘
        ▲                                                              ▲
        │                                                              │
┌───────┴──────────────────────────────────────────────────────────────────┐
│  OBSERVABILITY & AUDIT  (append-only, per-workspace, tamper-evident)     │
│  logs · metrics · traces · cost · latency · errors · human review        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Data-flow (single consequential action)

```
 user intent (Tamil/Tanglish/English text or voice)
        │
        ▼
 [1] Entry surface → Orchestrator (workspace + actor resolved)
        │
        ▼
 [2] Intent parsing → candidate capability + required commands
        │
        ▼
 [3] Policy Engine: resolve risk class, scope, role, approvals
        │
        ▼
 [4] Action Passport issued (or approval requested)  ── unauthorised → stop
        │
        ▼
 [5] Durable Workflow: checkpoint + idempotency key
        │
        ▼
 [6] Execute ONLY registered Command-Registry definition
        │
        ▼
 [7] Verify resulting state from authoritative source (≠ "API returned 200")
        │
        ▼
 [8] Receipt emitted (status, evidence, exceptions, next steps) → audit log
        │
        ▼
 [9] On failure: retry safe failures / compensate / escalate. Never fabricate.
```

### 2.4 Execution environments

- **Online**: full flow above.
- **Offline capture**: intent captured locally, queued encrypted; states are strictly `queued → pending → executed → verified` (and `failed`), never conflated.

---

## 3. Agent Registry and Command Registry schemas

### 3.1 Agent Registry entry (proposed, versioned contract)

File-of-record: one Markdown contract per agent under `agents/**/<agent>.md`, plus a machine-readable registry (JSON/YAML) generated/validated from them. Proposed schema:

```yaml
agent:
  id: string                # stable, e.g. "accountant"
  name: string
  display_name: string
  version: semver           # contract version, e.g. "1.0.0"
  description: string
  category: enum            # universal | personal | professional | business
  workspace_compatibility: enum[]   # personal | business
  licence_claimed: boolean  # must be false unless verifiable; see §5

contract:
  inputs:  { required: object, optional: object }
  outputs: { success: object, failure: object }
  capabilities_required: string[]    # capability ids that must be installed & healthy
  commands_allowed: string[]         # command ids from Command Registry (no arbitrary tools)
  delegation:
    allowed: boolean
    max_depth: integer
    can_expand_scope: boolean        # MUST be false (no permission inheritance expansion)

risk:
  risk_class: enum          # R0 | R1 | R2 | R3 | R4
  approval_policy: object   # { required: boolean, roles: string[], channel: string, expiry: string }
  prohibited_actions: string[]

verification:
  strategy: string          # how outcomes are verified from authoritative sources
  requires_human_signoff: boolean   # true for health/legal/accounting/engineering/finance/HR/safety

escalation:
  path: string              # who/what to escalate to, and when

evaluation:
  status: enum              # draft | tested | evaluated | approved | blocked
  tests: string[]
  red_team_status: enum

provenance:
  source: string
  commit: string
  dependencies: string[]
```

### 3.2 Command Registry entry (proposed, versioned)

One canonical definition consumed by UI, CLI, JSON API and MCP.

```yaml
command:
  id: string                # e.g. "email.send"
  name: string
  version: semver
  purpose: string
  trigger: string

inputs:   { required: object, optional: object, ambiguous_fields: string[] }
outputs:  { success: object, failure: object }

permission:
  scopes: string[]          # e.g. ["workspace:personal", "mail:send"]
  roles: string[]
  workspace_compatibility: enum[]

risk:
  risk_class: enum          # R0–R4
  approval_policy: object
  idempotency: { key_fields: string[], store: string }

execution:
  preconditions: string[]
  timeout: string
  retry: { max_attempts: integer, backoff: string, safe_to_retry: boolean }
  compensation: string      # rollback/compensating action or "none"

verification:
  method: string            # authoritative source check; never "response == success"
  evidence_required: string[]

audit:
  fields: string[]          # actor, workspace, target, operation, scope, risk, approval, expiry…
  receipt: boolean

tests: string[]
```

---

## 4. Permission / risk / approval matrix

### 4.1 Risk classes and autonomy (from the mindmap)

| Class | Meaning | Autonomy | Approval required | Verification | Compensation |
|---|---|---|---|---|---|
| **R0** | Local reasoning / draft; no external state change | Autonomous within scope | No | Not applicable | None needed |
| **R1** | Read-only retrieval within granted scope | Autonomous within scope | No (scope-bound) | Returned data labelled untrusted | None |
| **R2** | Reversible low-impact change | Autonomous if standing permission set | Standing permission may be configured | Confirm change applied | Reversible / undo |
| **R3** | External communication, purchase, money movement, sensitive disclosure, consequential account change | **Explicit approval by default** | Explicit user approval (role-checked) | Authoritative state check | Compensation where possible |
| **R4** | Destructive, safety-critical, regulated, production-impacting | **Human expert approval / dual control / disallowed** | Human expert sign-off (or disallowed) | Mandatory independent verification | Mandatory compensation plan |

### 4.2 Sensitive-operation mapping

| Operation | Minimum risk class | Required approval / role check | Extra guard |
|---|---|---|---|
| Send external communication | R3 | Explicit user approval | Recipient confirmation; no impersonation |
| Purchase / money movement | R3–R4 | Explicit approval + spend limit/role | Amount & recipient confirmation |
| Payroll | R4 | Human sign-off, dual control | Regulated; never auto-execute |
| Contracts | R4 | Human/legal sign-off | Never claim legal authority |
| Tax filing | R4 | Human/professional sign-off | Never claim licence |
| Sensitive sharing / PII disclosure | R3–R4 | Explicit approval, data-scope check | Minimisation + consent |
| Destructive change | R4 | Explicit approval + backup | Compensation plan |
| Production / deploy change | R4 | Change approval, role check | Rollback plan |
| Healthcare / legal / accounting / engineering / finance / HR / safety decisions | R4 | **Human expert sign-off boundary** | Agent must not hold licence or make reserved decisions |
| Read/draft/plan | R0–R1 | Within granted scope | None |

### 4.3 Standing rules

- **No permission inheritance expansion** during delegation (`can_expand_scope: false`).
- **No silent cross-workspace access**; every access scoped to a workspace/tenant.
- **Ambiguous** names, amounts, dates and recipients → **explicit confirmation** before execution (mapped via `ambiguous_fields` in the Command Registry).
- Untrusted content never overrides policy.

---

## 5. Integration and licensing audit

### 5.1 Current state

- **No dependencies, models, datasets, connectors or assets are integrated yet** — the repo is empty of code.
- Repository license: **MIT** (© 2026 Ebin0471). MIT is on the default allowlist and is compatible with the intended open-source distribution.

### 5.2 Policy to enforce (from the mindmap / master prompt)

- **Default allowlist: MIT / Apache-2.0 only**, subject to **file-level** review (repository-level licence labels are not blanket clearance).
- **Exclude** GPL / AGPL / SSPL / source-available / mixed / unclear components from the default product.
- Inspect **model weights, datasets, connectors, dependencies and assets separately** — each is a distinct review target.
- Preserve all notices; record origin, version, commit, modifications and obligations in an **SBOM and third-party notices**.
- If licence status is **uncertain → do not integrate; report for legal review**.

### 5.3 Required artifacts (to be created when dependencies are introduced)

- `NOTICE` / third-party notices file.
- `SBOM.json` (or equivalent) generated on dependency changes.
- A licence-review gate in CI before any new dependency is merged.

### 5.4 Open integration risks to resolve

- **Model provider** not chosen — model weights/licences (e.g. weight licences that are not MIT/Apache) must be reviewed separately and may block default reuse.
- **Tamil/Tanglish ASR/TTS** providers — licence + data-handling terms unknown; needs separate review.
- **Connector SDKs** for email/calendar/finance/etc. — each third-party API/SDK must pass file-level licence review.
- No SBOM exists yet — will be created at Phase C/D when dependencies land.

---

## 6. Phased implementation plan (A–I) with dependencies and test criteria

| Phase | Scope | Depends on | Exit / test criteria |
|---|---|---|---|
| **A. Discovery & gap analysis** | This document | — | Owner approval of this milestone |
| **B. Identity, workspace isolation, permissions, audit, Action Passport** | Account/org/roles, Personal + Business tenant isolation, policy engine skeleton, append-only audit, Action Passport issue/verify | A | Unit + integration tests: cross-tenant access denied; passport required for R3/R4; audit entries immutable; no secrets in logs |
| **C. Capability/Command Registry + connector SDK** | Typed Capability Fabric, canonical Command Registry, connector SDK, SBOM/notices | B | Same command definition resolves identically via UI/CLI/JSON API/MCP; schema validation tests; SBOM present |
| **D. Agent Registry, orchestrator, durable workflows** | Agent Registry + contract validation, orchestrator (plan/route/delegate/checkpoint/retry), durable workflow engine (idempotency, timeout, cancellation, compensation) | C | Delegation cannot expand scope; idempotent re-runs; safe-failure retry; compensation executes; receipt emitted |
| **E. Universal agents + core personal integrations** | Universal workforce agents, file/calendar/email/browser foundations, ambiguous-field confirmation | D | Per-agent contract tests; verification from authoritative source; no fabricated outcomes |
| **F. Professional agent packs + evaluations** | Profession agents, profession-specific evaluations, human sign-off boundaries | E | Each agent declares licence-claim=false; sign-off enforced for R4 domains; evaluation suite passes |
| **G. Business operations + vertical packs** | Business agents, tenant administration, vertical packs | E (parallel to F) | Tenant isolation tests; role/permission matrix tests per vertical |
| **H. Tamil/Tanglish voice + companions** | Tamil/Tanglish/English voice & text, ambiguous-name/amount/date/recipient confirmation, mobile/desktop/browser companions | E | ASR/TTS correctness + confirmation flows tested; licence review of voice stack |
| **I. Observability, safety eval, rollout, docs** | Metrics/traces/cost, red-team suite, controlled rollout, documentation | B–H | Red-team suite (prompt injection, privilege escalation, cross-tenant leakage, unsafe tool use, fabricated completion, recovery failures) green; rollout gates documented |

**Sequencing note:** Phases B–D are the security/execution spine and must land first and be hardened before any agent is wired to real external actions (E onward). Each phase should be a bounded, separately-approved milestone.

---

## 7. What has NOT been done (scope control)

- **No source code, schemas, tests, CI or configuration have been created or modified.**
- No agents have been implemented; no dependencies have been added.
- This turn is **discovery + the planning artifacts above only**, per the master prompt's "wait for explicit milestone approval before making source changes."

---

## 8. Unresolved decisions requiring owner approval

1. ~~**Missing blueprint/governance/agent files.**~~ **Resolved as a decision; import blocked.** Owner confirmed the complete Universal Workforce package is the authoritative baseline (not the standalone mind map). However, the supplied package `BEAN-AUTOPILOT-UNIVERSAL-WORKFORCE.zip` was **not present** in the workspace; the 117 agent specifications, `blueprints/`, `governance/` and `prompts/` documents could not be imported. **Action required: re-supply the zip.** The mind map filename discrepancy is resolved by importing the supplied mind map as `BEAN-AUTOPILOT-MASTER-MINDMAP.md` (content preserved).
2. **Tech stack.** No stack is specified and nothing exists. Recommend a default (TypeScript/Node monorepo for a single language across UI/CLI/API/MCP, or Python for data-heavy agent work). Owner to choose.
3. **Datastore / queue / infrastructure.** No infrastructure choices made (database, durable queue, object store, deployment target). Needs a decision.
4. **Model provider & execution.** Local vs cloud, which model(s), and how model-weight licences are reviewed (see §5.4).
5. **Tamil/Tanglish voice stack.** ASR/TTS provider and licence/data-handling review.
6. **Approval channel.** How explicit approvals are delivered (in-app, email, SMS, hardware key) and how R4 dual-control is implemented.
7. **Tenant & data model details.** Business tenant/member model, retention, jurisdiction, deletion — needs a concrete decision before Phase B schemas are frozen.
8. **Whether to bootstrap the missing blueprint/governance files into the repo** as part of Phase A, or treat this document as the interim baseline.

---

## 9. Final documentation baseline, file inventory and Phase B scope

### 9.1 Documentation baseline (owner-approved)

The owner approved the **complete BEAN Autopilot Universal Workforce package** as the authoritative product and agent-governance baseline, and authorised **documentation import and GitHub publication only**. The canonical mind-map filename is `BEAN-AUTOPILOT-MASTER-MINDMAP.md`. The repository's MIT LICENSE and Ebin0471 copyright attribution are preserved and are not interpreted as granting relicensing rights over third-party dependencies or model assets.

### 9.2 Exact file inventory (verified, current working tree)

| Path | Status | Notes |
|---|---|---|
| `LICENSE` | **Preserved** | MIT, © 2026 Ebin0471 — unchanged |
| `README.md` | **Updated** | Rewritten as the central GitHub README (purpose, architecture, agent categories, navigation, honest implementation status, licence) |
| `BEAN-AUTOPILOT-MASTER-MINDMAP.md` | **Added** | Imported from supplied `BEAN-AUTOPILOT-UNIVERSAL-MINDMAP.md`; byte-identical content, canonical filename |
| `MILESTONES/MILESTONE-1-DISCOVERY-AND-ARCHITECTURE.md` | **Added/Updated** | This report |
| `agents/universal/`, `agents/personal/`, `agents/professional/`, `agents/business/` | **Not imported** | Blocked — package zip absent |
| `blueprints/UNIVERSAL-WORKFORCE-BLUEPRINT.md`, `blueprints/AGENT-CATALOG.md` | **Not imported** | Blocked — package zip absent |
| `governance/AGENT-EXECUTION-CONTRACT.md`, `governance/REPOSITORY-LICENSE-POLICY.md`, `governance/ACTION-INDEX.md` | **Not imported** | Blocked — package zip absent |
| `prompts/MASTER-BUILD-PROMPT.md` | **Not imported** | Blocked — package zip absent |

**Agent specification files imported and verified: 0 of 117.** All four categories are currently unrepresented because the package was not supplied.

### 9.3 Publication status

**Commit, push and pull request have NOT been performed.** The owner authorised publication of the *complete documentation update*. Because the complete package (117 agent specifications + governance/blueprint/prompt documents) could not be imported, publishing now would present an incomplete baseline as the authorised complete package — which the owner's instructions explicitly forbid ("report the exact blocker rather than publishing to an assumed destination"; "never claim an action succeeded unless verified"). All legitimately supplied artifacts and accurate documentation updates are prepared and validated locally; publication will proceed immediately once the package is re-supplied.

### 9.4 Contradiction review status

**Blocked.** The requested reconciliation of the architecture report against the mind map, individual agent specifications and governance contracts cannot be completed until the 117 agent files and governance/blueprint documents are imported. The mind map and this report are consistent (this report's schemas and matrix derive from the mind map's own definitions). No contradictions can be identified against documents that were not supplied.

### 9.5 Proposed Phase B scope (NOT started; awaiting owner approval)

Phase B — **Identity, workspace isolation, permissions, audit and Action Passport** — remains deferred. Proposed bounded scope (for owner approval, to be refined against the actual governance contracts once imported):

1. Account, organisation and role model; Personal + Business tenant isolation with separate data, memory, credentials and audit.
2. Policy engine skeleton implementing R0–R4 autonomy and approval gating.
3. Append-only, per-workspace audit log (tamper-evident; no secrets).
4. Action Passport issue/verify: actor, workspace, target, operation, data scope, permission, risk, approval, expiry, verification plan.
5. Tests: cross-tenant access denied; passport mandatory for R3/R4; audit immutability; no secret leakage.

**Phase B will not begin until the owner explicitly approves the revised architecture and risk model** (which must be reconciled against the imported governance contracts) and the documentation package is present.

---

*Prepared by the principal implementation agent. Documentation baseline approved and partially imported; publication held pending re-supply of `BEAN-AUTOPILOT-UNIVERSAL-WORKFORCE.zip`. No application implementation has begun.*
