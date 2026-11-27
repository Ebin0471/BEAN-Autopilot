# BEAN Autopilot

**BEAN Autopilot** is a permission-controlled AI operating platform for individuals, professionals, small vendors, organisations and enterprises. Using text, Tamil, Tanglish or voice, it connects apps, devices and AI agents to automate tasks, manage operations and execute authorised actions securely — all from one place.

The platform turns user intent into **authorised, verified outcomes** through a shared execution spine: understand intent → discover capability → plan → authorise → execute → verify → recover → report.

## Architecture (high level)

| Layer | Role |
|---|---|
| Entry surfaces | Web UI, CLI, JSON API and MCP — all call the same canonical command definitions |
| Orchestrator | Task decomposition, routing, delegation, concurrency limits, reconciliation, safe retry |
| Policy engine | Risk-based autonomy, role/scope checks, tenant isolation, approval gating |
| Action Passport | Per-consequential-action record: actor, workspace, target, operation, data scope, permission, risk, approval, expiry, verification plan |
| Registries | Agent Registry (versioned agent contracts) and Command Registry (one canonical command for all surfaces) |
| Capability Fabric | Typed connector SDK with schemas, scopes, risk levels and verification methods |
| Durable workflows | Idempotency, checkpoints, timeouts, cancellation, compensation, resumability |
| Verification & recovery | Evidence-backed receipts; real-state verification from authoritative sources; compensation |
| Memory & knowledge | User-controlled, source-linked, scoped and revocable, per workspace |
| Observability & audit | Logs, metrics, traces, cost, latency, errors and human review; append-only per workspace |

Risk classes **R0–R4** govern autonomy: local reasoning/read-only (R0–R1) proceed within granted scope; reversible low-impact changes (R2) may use standing permission; external communication, purchases, money movement and sensitive disclosure (R3) require explicit approval by default; destructive, safety-critical, regulated or production-impacting actions (R4) require human expert sign-off, dual control or are disallowed.

## Agent categories

Agents are governed by versioned contracts (inputs/outputs, permitted commands, permission scopes, risk class, approval policy, verification strategy, escalation path and tests). No agent may expand permissions during delegation, and regulated domains (healthcare, legal, accounting, engineering, finance, HR, safety) require clear human sign-off boundaries.

- **Universal workforce** — Chief of Staff, Personal Assistant, Research & Fact Checking, Planner, Communications, Documents & Knowledge, Meetings, Finance Organiser, Learning Coach, Wellbeing Coach, Travel Planner, Shopping Assistant, Home Manager, Accessibility, Security & Privacy, Automation Designer, Data Analyst, Translator, Customer Support, Quality Auditor.
- **Personal life** — Family Coordinator, Parenting Organiser, Career Coach, Job Search, Creator Manager, Personal Archive, Fitness Organiser, Meal Planner, Pet Care.
- **Professional careers** — Editor, Graphic Designer, UI/UX Designer, Software Developer, QA Engineer, DevOps Engineer, Data Scientist, Teacher, Academic Researcher, Healthcare Administration, Legal Research, Accountant, Architect, Engineers, Construction Manager, Real Estate, Farmer, Journalist, Photographer, HR, Recruiter, Marketing, Sales, Consultant, Mechanic, Hospitality, Logistics, Scientist.
- **Business operations** — Owner Chief of Staff, Operations, Accounting & Bookkeeping, Invoicing, Payroll, Tax Coordination, CRM, Customer Success, Sales/Marketing Operations, Social Media, E-commerce, Retail, Restaurant, Inventory, Procurement, Supply Chain, Manufacturing, Quality Control, Maintenance, Project Management, HR, Recruitment, Training, Contracts, Compliance, Risk, IT Helpdesk, Cybersecurity, Business Intelligence, Customer Feedback, Franchise, Clinic/School Administration, Agency Operations, Property Management, Fleet, Export/Import, Nonprofit, Insurance/Financial Services Administration, Event Management, Field Service, Salon/Spa, Gym, Pharmacy Retail, Agriculture Business, Transport, Hotel, B2B Partnerships.

## Documentation navigation

Target repository structure:

```
BEAN-AUTOPILOT/
├── LICENSE
├── README.md
├── BEAN-AUTOPILOT-MASTER-MINDMAP.md   # canonical mind map (product/agent-governance baseline)
├── agents/
│   ├── universal/                     # individual agent contract Markdown files
│   ├── personal/
│   ├── professional/
│   └── business/
├── blueprints/
│   ├── UNIVERSAL-WORKFORCE-BLUEPRINT.md
│   └── AGENT-CATALOG.md
├── governance/
│   ├── AGENT-EXECUTION-CONTRACT.md
│   ├── REPOSITORY-LICENSE-POLICY.md
│   └── ACTION-INDEX.md
├── prompts/
│   └── MASTER-BUILD-PROMPT.md
└── MILESTONES/
    └── MILESTONE-1-DISCOVERY-AND-ARCHITECTURE.md
```

Start here:

- **[BEAN-AUTOPILOT-MASTER-MINDMAP.md](BEAN-AUTOPILOT-MASTER-MINDMAP.md)** — the canonical mind map: workforce map, shared platform architecture, agent lifecycle, universal action contract, risk classes and security rules. *(Previously distributed as `BEAN-AUTOPILOT-UNIVERSAL-MINDMAP.md`; renamed to the canonical filename with no content change.)*
- **[MILESTONES/MILESTONE-1-DISCOVERY-AND-ARCHITECTURE.md](MILESTONES/MILESTONE-1-DISCOVERY-AND-ARCHITECTURE.md)** — repository assessment, target architecture and data flow, Agent/Command Registry schemas, permission/risk/approval matrix, licensing policy, phased roadmap A–I and unresolved decisions.

## Current implementation status

**Documentation baseline only.** No application source, database schema, authentication, agent runtime, API, connector, infrastructure or deployment is implemented, and none is implied by this repository.

The complete universal workforce documentation package (the 117 individual agent specifications plus supporting blueprint, governance and prompt documents) is the authoritative baseline and is being imported into the structure above. The current repository state, exact file inventory and the pending-import blocker are recorded in the Milestone 1 report. **No Phase B (identity, workspace isolation, permissions, audit, Action Passport) or any application implementation has begun**, and will not begin until the owner approves the revised architecture and risk model.

## Licence

This repository is licensed under the **MIT License** — see [LICENSE](LICENSE). Copyright (c) 2026 Ebin0471.

The MIT licence covers this repository's own content only. It does **not** grant permission to relicense third-party dependencies, model weights, datasets, fonts, assets or connectors. Third-party components must pass exact MIT/Apache-2.0 file-level review before inclusion; GPL, AGPL, SSPL, source-available, mixed or unclear components are excluded from the default product. See the repository licensing policy under `governance/` and the Milestone 1 report for details.
