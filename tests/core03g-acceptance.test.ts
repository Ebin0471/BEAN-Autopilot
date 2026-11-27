// @vitest-environment node

/**
 * CORE-03G — Live AI provider acceptance script (vitest-run).
 *
 * Exercises the REAL provider adapters (BEAN Intelligence, OpenAI-compatible,
 * local inference) against their live endpoints when credentials are present in
 * the environment. This performs genuine inference and verifies:
 *   - health check succeeds and reports the provider reachable;
 *   - listModels returns a non-empty, honest model projection;
 *   - generate returns real model content (non-empty);
 *   - stream returns real delta content + a terminal complete/error frame.
 *
 * SECURITY: credentials are read only from the server-side environment and are
 * NEVER printed. When a provider is not configured (env absent), that
 * provider's checks are SKIPPED with an honest reason — the script never
 * fabricates a result and never falls back to the test provider.
 *
 * Run with: `npx vitest run tests/core03g-acceptance.test.ts`
 * (or `npm test` — it skips cleanly when no live credentials are set.)
 */
import { describe, it, expect } from "vitest";

import {
  BeanIntelligenceAdapter,
  BEAN_BASE_URL_ENV,
  BEAN_API_KEY_ENV,
} from "@/lib/ai/providers/bean-intelligence";
import {
  OpenAICompatibleAdapter,
  OPENAI_BASE_URL_ENV,
  OPENAI_API_KEY_ENV,
  OPENAI_MODEL_ENV,
} from "@/lib/ai/providers/openai-compatible";
import {
  LocalInferenceAdapter,
  LOCAL_BASE_URL_ENV,
  LOCAL_MODEL_ENV,
} from "@/lib/ai/providers/local-inference";
import { defaultEndpointPolicy, validateBaseUrl } from "@/lib/ai/endpoint-safety";
import type { AIProviderAdapter, AIRequest } from "@/lib/ai/types";

function beanConfigured(): boolean {
  return Boolean(process.env[BEAN_BASE_URL_ENV] && process.env[BEAN_API_KEY_ENV]);
}
function openaiConfigured(): boolean {
  return Boolean(
    process.env[OPENAI_BASE_URL_ENV] &&
      process.env[OPENAI_API_KEY_ENV] &&
      process.env[OPENAI_MODEL_ENV],
  );
}
function localConfigured(): boolean {
  const allowLocal =
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS === "1" ||
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS === "true";
  return Boolean(process.env[LOCAL_BASE_URL_ENV] && process.env[LOCAL_MODEL_ENV] && allowLocal);
}

const requestFor = (suffix: string): AIRequest => ({
  requestId: `accept-${suffix}`,
  modelId: "default",
  messages: [{ role: "user", content: "Reply with the single word: ready" }],
  taskCategory: "GENERAL_CHAT",
});

async function checkProvider(adapter: AIProviderAdapter, label: string): Promise<void> {
  // Health.
  const health = await adapter.healthCheck();
  expect(health.healthy, `${label} health should be reachable`).toBe(true);

  // Models.
  const models = await adapter.listModels();
  expect(models.length, `${label} should list models`).toBeGreaterThan(0);

  // Generate.
  const gen = await adapter.generate({
    ...requestFor(`${label}-gen`),
    modelId: models[0].modelId,
  });
  expect(gen.error, `${label} generate should not error`).toBeUndefined();
  expect(gen.content.trim().length, `${label} generate should return content`).toBeGreaterThan(0);

  // Stream.
  let deltas = "";
  let terminal = false;
  let streamError: string | null = null;
  for await (const event of adapter.stream({
    ...requestFor(`${label}-stream`),
    modelId: models[0].modelId,
    messages: [{ role: "user", content: "Count from one to five." }],
  })) {
    if (event.type === "delta" && event.delta) deltas += event.delta;
    else if (event.type === "complete") terminal = true;
    else if (event.type === "error") streamError = event.error?.message ?? "error";
  }
  expect(streamError, `${label} stream should not error`).toBeNull();
  expect(deltas.trim().length, `${label} stream should yield deltas`).toBeGreaterThan(0);
  expect(terminal, `${label} stream should reach a terminal frame`).toBe(true);
}

describe("CORE-03G — live provider acceptance", () => {
  it.skipIf(!beanConfigured())(
    "BEAN Intelligence",
    async () => {
      const base = process.env[BEAN_BASE_URL_ENV]!;
      const key = process.env[BEAN_API_KEY_ENV]!;
      validateBaseUrl(base, defaultEndpointPolicy());
      const adapter = new BeanIntelligenceAdapter("bean.intelligence", base, key);
      await checkProvider(adapter, "BEAN Intelligence");
    },
  );

  it.skipIf(!openaiConfigured())(
    "OpenAI-compatible",
    async () => {
      const base = process.env[OPENAI_BASE_URL_ENV]!;
      const key = process.env[OPENAI_API_KEY_ENV]!;
      const model = process.env[OPENAI_MODEL_ENV]!;
      validateBaseUrl(base, defaultEndpointPolicy());
      const adapter = new OpenAICompatibleAdapter(
        "openai.compatible",
        base,
        key,
        model,
        model,
      );
      await checkProvider(adapter, "OpenAI-compatible");
    },
  );

  it.skipIf(!localConfigured())(
    "Local inference",
    async () => {
      const base = process.env[LOCAL_BASE_URL_ENV]!;
      const model = process.env[LOCAL_MODEL_ENV]!;
      validateBaseUrl(base, defaultEndpointPolicy());
      const adapter = new LocalInferenceAdapter("local.endpoint", base, model, model);
      await checkProvider(adapter, "Local inference");
    },
  );
});
