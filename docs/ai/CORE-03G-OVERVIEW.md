# CORE-03G — Live AI Providers, BEAN Intelligence Integration & Real-Time Chat

## Overview

CORE-03G connects the provider-neutral CORE-03 intelligence engine to **genuine
AI inference**. It delivers real model responses and **true upstream token
streaming** — never a simulated test provider masquerading as a live model.

The architecture is a governed pipeline:

```
USER → CHAT → INTENT ENGINE → MODEL ROUTER → REAL AI PROVIDER
     → PLANNER → AGENT ORCHESTRATOR → CORE-02 COMMAND GATEWAY → VERIFIED RESULT
```

The model **never directly executes privileged operations**. It only produces
text (intent classification, planning, and the final natural-language response).
All command execution flows through the CORE-02 governed gateway, which enforces
identity, permissions, risk, capability, passport, and lifecycle.

## What CORE-03G adds

| Component | Purpose |
|-----------|---------|
| `BeanIntelligenceAdapter` | Native adapter for the BEAN Intelligence public gateway (`/api/v1`). |
| `OpenAICompatibleAdapter` | Reusable adapter for any OpenAI Chat-Completions-compatible endpoint. |
| `LocalInferenceAdapter` | Adapter for locally-hosted inference (opt-in, SSRF-guarded). |
| `sse.ts` | Robust SSE parser (arbitrary chunks, CRLF, keepalive, terminal, typed errors). |
| `endpoint-safety.ts` | SSRF / endpoint validation before every outbound request. |
| `consent.ts` | Server-side workspace external-AI consent (fail-closed). |
| `http.ts` | Shared typed HTTP client (timeout, abort, error mapping, no redirect-follow). |
| `migrations.ts` | Additive DB migrations for the new schema columns + consent table. |
| Orchestrator `composeModelResponse` | Real model-generated final response + bounded fallback. |

## Key design principles

1. **Registration is not availability.** An env-configured provider with no
   credentials registers `CONFIGURATION_REQUIRED` with a no-op adapter that
   throws on `generate`/`stream`. It never pretends to be connected.
2. **Fail closed on untrusted model output.** Intent/plan schemas are validated
   with Zod; unknown command ids are rejected. The orchestrator executes ONLY
   R0/R1 approval-free commands and never auto-approves consequential actions.
3. **No AI provider SDK.** The CORE-03 provider contract is a local
   `AIProviderAdapter` interface plus a deterministic test provider. No external
   SDK is installed.
4. **Bounded fallback.** Once a stream delta is emitted, the orchestrator never
   falls back to another provider or the template (that would emit
   contradictory content). Fallback is only possible before the first delta.
5. **Honest capability reporting.** No invented tools, reasoning, context, or
   pricing. The BEAN gateway does not support native tool calls or
   `response_format` — it is marked `PROMPTED_JSON` with `toolCallSupported: false`.
6. **Secrets are server-side only.** API keys are read from the environment,
   never logged, never stored in ordinary records, and never sent to the browser.

## Files

- Adapters: `lib/ai/providers/{bean-intelligence,openai-compatible,local-inference}.ts`
- Infrastructure: `lib/ai/{sse,endpoint-safety,http,consent}.ts`
- Orchestration: `lib/ai/orchestrator.ts` (`composeModelResponse`)
- Chat route: `app/api/ai/chat/route.ts` (true upstream streaming)
- Tests: `tests/core03g-security.test.ts`, `tests/core03g-acceptance.test.ts`
