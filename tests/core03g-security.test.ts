// @vitest-environment node

/**
 * CORE-03G — Security & integrity tests for the live-AI integration layer.
 *
 * Covers the pieces that must fail safely: the robust SSE parser (arbitrary
 * chunk boundaries, CRLF, keepalive, terminal done, typed errors, partial vs
 * complete, truncation, abort), endpoint/SSRF safety, workspace external-AI
 * consent enforcement, the test-provider production restriction, and honest
 * provider capability reporting.
 */
import { describe, it, expect, beforeEach } from "vitest";

process.env.BEAN_DB_PATH = ":memory:";

import {
  parseSSEStream,
  type SSEStreamResult,
} from "@/lib/ai/sse";
import {
  validateBaseUrl,
  defaultEndpointPolicy,
  EndpointSafetyError,
  type EndpointPolicy,
} from "@/lib/ai/endpoint-safety";
import {
  getConsent,
  setConsent,
  assertProviderAllowed,
  ConsentError,
} from "@/lib/ai/consent";
import { createUnconfiguredBeanAdapter } from "@/lib/ai/providers/bean-intelligence";
import { createDefaultTestProvider } from "@/lib/ai/providers/test-provider";
import { getDb } from "@/lib/db/database";
import { getServices } from "@/lib/security/container";
import { uuid } from "@/lib/db/util";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asyncChunks(parts: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= parts.length) return { value: undefined, done: true };
          return { value: encoder.encode(parts[i++]), done: false };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

describe("CORE-03G — robust SSE parser", () => {
  it("parses a normal delta + terminal done stream", async () => {
    const stream = asyncChunks([
      'data: {"delta":"Hello"}\n\n',
      'data: {"delta":" world"}\n\n',
      'data: {"done":true,"model":"bean-chat-hosted"}\n\n',
    ]);
    const result = await parseSSEStream(stream);
    expect(result.content).toBe("Hello world");
    expect(result.terminal).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.done).toBeTruthy();
    expect(result.error).toBeNull();
  });

  it("handles arbitrary chunk boundaries (frame split across chunks)", async () => {
    // The same stream, but split mid-frame.
    const stream = asyncChunks([
      'data: {"de',
      'lta":"Hi"}\n\ndata: {"delta":" there"}\n\n',
      'data: {"done":true}\n\n',
    ]);
    const result = await parseSSEStream(stream);
    expect(result.content).toBe("Hi there");
    expect(result.terminal).toBe(true);
  });

  it("handles CRLF line endings", async () => {
    const stream = asyncChunks([
      'data: {"delta":"A"}\r\n\r\ndata: {"delta":"B"}\r\n\r\ndata: {"done":true}\r\n\r\n',
    ]);
    const result = await parseSSEStream(stream);
    expect(result.content).toBe("AB");
    expect(result.terminal).toBe(true);
  });

  it("ignores keepalive comment frames", async () => {
    const stream = asyncChunks([
      ': keepalive\n\n',
      'data: {"delta":"X"}\n\n',
      ': keepalive\n\n',
      'data: {"done":true}\n\n',
    ]);
    const result = await parseSSEStream(stream);
    expect(result.content).toBe("X");
    expect(result.terminal).toBe(true);
  });

  it("surfaces a typed error frame as terminal", async () => {
    const stream = asyncChunks([
      'data: {"delta":"partial"}\n\n',
      'data: {"error":"upstream boom","code":"UPSTREAM_ERROR","partial":true}\n\n',
    ]);
    const result = await parseSSEStream(stream);
    expect(result.content).toBe("partial");
    expect(result.error).toEqual({
      code: "UPSTREAM_ERROR",
      message: "upstream boom",
      partial: true,
    });
    expect(result.terminal).toBe(true);
  });

  it("marks a stream without a terminal frame as truncated", async () => {
    const stream = asyncChunks(['data: {"delta":"abc"}\n\n']);
    const result = await parseSSEStream(stream);
    expect(result.content).toBe("abc");
    expect(result.terminal).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("enforces the maximum response-size bound", async () => {
    const big = "data: " + JSON.stringify({ delta: "x".repeat(1000) }) + "\n\n";
    const stream = asyncChunks([big, big, big, big, big]);
    const result = await parseSSEStream(stream, undefined, { maxBytes: 2000 });
    expect(result.truncated).toBe(true);
    expect(result.terminal).toBe(false);
  });

  it("stops cleanly on abort", async () => {
    const controller = new AbortController();
    const stream = asyncChunks([
      'data: {"delta":"a"}\n\n',
      'data: {"delta":"b"}\n\n',
      'data: {"done":true}\n\n',
    ]);
    controller.abort();
    const result = await parseSSEStream(stream, controller.signal);
    // Aborted before consumption: content is empty and not terminal.
    expect(result.terminal).toBe(false);
  });

  it("treats non-JSON data frames as raw delta text (not terminal)", async () => {
    const stream = asyncChunks(['data: plain text\n\n']);
    const result = await parseSSEStream(stream);
    expect(result.content).toContain("plain text");
    expect(result.terminal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Endpoint / SSRF safety
// ---------------------------------------------------------------------------

describe("CORE-03G — endpoint safety (SSRF)", () => {
  const allowLocal: EndpointPolicy = {
    allowLocalEndpoints: false,
    requireHttpsInProduction: true,
  };

  it("accepts a valid HTTPS public endpoint", () => {
    const url = validateBaseUrl("https://gateway.example.com", allowLocal);
    expect(url.hostname).toBe("gateway.example.com");
  });

  it("rejects non-http schemes", () => {
    expect(() => validateBaseUrl("ftp://host", allowLocal)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("file:///etc/passwd", allowLocal)).toThrow(EndpointSafetyError);
  });

  it("rejects loopback / private hosts when local endpoints are disabled", () => {
    expect(() => validateBaseUrl("http://127.0.0.1:8080", allowLocal)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("http://localhost:11434", allowLocal)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("http://10.0.0.5", allowLocal)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("http://169.254.169.254", allowLocal)).toThrow(EndpointSafetyError);
  });

  it("blocks cloud metadata hosts", () => {
    expect(() => validateBaseUrl("http://169.254.169.254", allowLocal)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("http://metadata.google.internal", allowLocal)).toThrow(
      EndpointSafetyError,
    );
  });

  it("rejects embedded credentials", () => {
    expect(() => validateBaseUrl("https://user:pass@host", allowLocal)).toThrow(EndpointSafetyError);
  });

  it("rejects query strings and fragments", () => {
    expect(() => validateBaseUrl("https://host?x=1", allowLocal)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("https://host#frag", allowLocal)).toThrow(EndpointSafetyError);
  });

  it("rejects invalid URLs", () => {
    expect(() => validateBaseUrl("not a url", allowLocal)).toThrow(EndpointSafetyError);
  });

  it("permits a local host only when explicitly opted in", () => {
    const localPolicy: EndpointPolicy = {
      allowLocalEndpoints: true,
      requireHttpsInProduction: true,
    };
    const url = validateBaseUrl("http://127.0.0.1:11434", localPolicy);
    expect(url.hostname).toBe("127.0.0.1");
  });

  it("default policy reflects the BEAN_AI_ALLOW_LOCAL_ENDPOINTS flag", () => {
    const prev = process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS;
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS = "1";
    expect(defaultEndpointPolicy().allowLocalEndpoints).toBe(true);
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS = prev ?? undefined;
    if (prev === undefined) delete process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS;
    expect(defaultEndpointPolicy().allowLocalEndpoints).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consent enforcement
// ---------------------------------------------------------------------------

describe("CORE-03G — workspace external-AI consent", () => {
  let db: ReturnType<typeof getDb>;
  let workspaceIds: string[];

  beforeEach(() => {
    db = getDb();
    // The consent table has a FK to workspaces; create real workspaces.
    const services = getServices();
    const { user } = services.identity.linkAuthAccount("consent-user", `route:${uuid()}`, {
      displayName: "Consent User",
    });
    workspaceIds = [];
    for (let i = 0; i < 4; i++) {
      const ws = services.workspace.createWorkspace(user.id, "PERSONAL", `Consent WS ${i}`);
      services.workspace.setMembership(ws.id, user.id, "OWNER", ws.id);
      workspaceIds.push(ws.id);
    }
  });

  const ws = () => workspaceIds[0];
  const ws2 = () => workspaceIds[1];
  const ws3 = () => workspaceIds[2];
  const ws4 = () => workspaceIds[3];

  it("denies external AI by default (fail-closed)", () => {
    expect(() =>
      assertProviderAllowed(db, ws(), "EXTERNAL", "bean.intelligence"),
    ).toThrow(ConsentError);
    expect(getConsent(db, ws()).externalAiAllowed).toBe(false);
  });

  it("allows internal providers without consent", () => {
    expect(() => assertProviderAllowed(db, ws(), "INTERNAL")).not.toThrow();
    expect(() => assertProviderAllowed(db, ws(), "LOCAL")).not.toThrow();
  });

  it("allows external AI after consent is granted", () => {
    setConsent(db, ws2(), {
      externalAiAllowed: true,
      allowedExternalProviderIds: ["bean.intelligence"],
      consentedBy: "user-1",
    });
    expect(() =>
      assertProviderAllowed(db, ws2(), "EXTERNAL", "bean.intelligence"),
    ).not.toThrow();
  });

  it("rejects a provider not in the allowed list", () => {
    setConsent(db, ws3(), {
      externalAiAllowed: true,
      allowedExternalProviderIds: ["bean.intelligence"],
      consentedBy: "user-1",
    });
    expect(() =>
      assertProviderAllowed(db, ws3(), "EXTERNAL", "openai.compatible"),
    ).toThrow(ConsentError);
  });

  it("is idempotent on re-grant", () => {
    setConsent(db, ws4(), {
      externalAiAllowed: true,
      allowedExternalProviderIds: [],
      consentedBy: "user-1",
    });
    setConsent(db, ws4(), {
      externalAiAllowed: true,
      allowedExternalProviderIds: ["bean.intelligence"],
      consentedBy: "user-2",
    });
    const consent = getConsent(db, ws4());
    expect(consent.externalAiAllowed).toBe(true);
    expect(consent.allowedExternalProviderIds).toContain("bean.intelligence");
    expect(consent.consentedBy).toBe("user-2");
  });
});

// ---------------------------------------------------------------------------
// Provider honesty
// ---------------------------------------------------------------------------

describe("CORE-03G — provider honesty", () => {
  it("unconfigured BEAN adapter reports CONFIGURATION_REQUIRED and fails on use", async () => {
    const prevBase = process.env.BEAN_INTELLIGENCE_BASE_URL;
    const prevKey = process.env.BEAN_INTELLIGENCE_API_KEY;
    delete process.env.BEAN_INTELLIGENCE_BASE_URL;
    delete process.env.BEAN_INTELLIGENCE_API_KEY;

    const { adapter, reason } = createUnconfiguredBeanAdapter("bean.intelligence");
    const meta = adapter.describe();
    expect(meta.availabilityStatus).toBe("CONFIGURATION_REQUIRED");
    expect(meta.endpointRef).toBeNull();
    expect(meta.authRef).toBeNull();
    // BEAN has no native tool calls.
    expect(meta.toolCallSupported).toBe(false);
    // Structured output is PROMPTED_JSON (no native schema).
    expect(meta.structuredOutputMode).toBe("PROMPTED_JSON");

    await expect(
      adapter.generate({
        requestId: "r1",
        modelId: "bean-chat-hosted",
        messages: [{ role: "user", content: "hi" }],
        taskCategory: "GENERAL_CHAT",
      }),
    ).rejects.toThrow();

    expect(reason).toContain("BEAN_INTELLIGENCE_BASE_URL");

    if (prevBase !== undefined) process.env.BEAN_INTELLIGENCE_BASE_URL = prevBase;
    if (prevKey !== undefined) process.env.BEAN_INTELLIGENCE_API_KEY = prevKey;
  });

  it("test provider reports PROMPTED_JSON and never claims native schema", () => {
    const { adapter } = createDefaultTestProvider();
    const meta = adapter.describe();
    expect(meta.structuredOutputMode).toBe("PROMPTED_JSON");
    expect(meta.streamingSupported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test-provider production restriction
// ---------------------------------------------------------------------------

describe("CORE-03G — test-provider production restriction", () => {
  // Use a mutable env override (process.env.NODE_ENV is typed read-only).
  const env = process.env as { NODE_ENV: string };
  const prevEnv = env.NODE_ENV;
  const setNodeEnv = (value: string) => {
    env.NODE_ENV = value;
  };

  it("test provider refuses to generate in production", async () => {
    setNodeEnv("production");
    try {
      const { adapter } = createDefaultTestProvider();
      await expect(
        adapter.generate({
          requestId: "r2",
          modelId: "test.general",
          messages: [{ role: "user", content: "hi" }],
          taskCategory: "GENERAL_CHAT",
        }),
      ).rejects.toThrow(/not permitted in production/i);
    } finally {
      setNodeEnv(prevEnv);
    }
  });

  it("test provider stream refuses in production", async () => {
    setNodeEnv("production");
    try {
      const { adapter } = createDefaultTestProvider();
      const gen = adapter.stream({
        requestId: "r3",
        modelId: "test.general",
        messages: [{ role: "user", content: "hi" }],
        taskCategory: "GENERAL_CHAT",
      });
      const iterator = gen[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow(/not permitted in production/i);
    } finally {
      setNodeEnv("test");
    }
  });
});

// ---------------------------------------------------------------------------
// SSE partial-vs-complete honesty
// ---------------------------------------------------------------------------

describe("CORE-03G — SSE partial vs complete honesty", () => {
  it("an error frame with partial content yields the partial content", async () => {
    const stream = asyncChunks([
      'data: {"delta":"partial answer"}\n\n',
      'data: {"error":"rate limited","code":"RATE_LIMITED","partial":true}\n\n',
    ]);
    const result = await parseSSEStream(stream);
    expect(result.content).toBe("partial answer");
    expect(result.error?.partial).toBe(true);
    expect(result.terminal).toBe(true);
  });

  it("a complete terminal frame has no error", async () => {
    const stream = asyncChunks([
      'data: {"delta":"done"}\n\n',
      'data: {"done":true}\n\n',
    ]);
    const result: SSEStreamResult = await parseSSEStream(stream);
    expect(result.error).toBeNull();
    expect(result.terminal).toBe(true);
  });
});
