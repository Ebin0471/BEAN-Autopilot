// @vitest-environment node

/**
 * CORE-03G.2 — Post-delivery security review & corrective hardening tests.
 *
 * Targeted regression tests for the five corrected findings:
 *   1. Empty provider allowlist must deny all external providers.
 *   2. IPv6 and IPv4-mapped IPv6 SSRF classification (canonical parsing).
 *   4. Fallback routing enforces full eligibility (consistent with primary).
 *   5. Streaming idle timeout and resource cleanup.
 *
 * (Finding #3 — workspace-switching consent refresh — is covered by
 * tests/core03g2-settings.test.tsx.)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";

process.env.BEAN_DB_PATH = ":memory:";

import {
  getConsent,
  setConsent,
  assertProviderAllowed,
  hasExternalAiConsent,
  ConsentError,
} from "@/lib/ai/consent";
import {
  isBlockedIp,
  parseIp,
  isIpLiteral,
  isMetadataHost,
  isBlockedHostname,
} from "@/lib/ai/endpoint-safety";
import { httpSSEStream, ProviderHTTPError } from "@/lib/ai/http";
import { ModelRouter, RoutingError } from "@/lib/ai/routing";
import type { ModelMetadata, Modality, RoutingConstraints, TaskCategory } from "@/lib/ai/types";
import { ProviderRegistry } from "@/lib/ai/provider-registry";
import { ModelRegistry } from "@/lib/ai/model-registry";
import { createDefaultTestProvider } from "@/lib/ai/providers/test-provider";
import { getDb } from "@/lib/db/database";
import { getServices, type Services } from "@/lib/security/container";
import { SESSION_COOKIE } from "@/lib/api/http";
import { uuid } from "@/lib/db/util";

// Route tests need a mocked session cookie.
let mockToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && mockToken ? { value: mockToken } : undefined,
  }),
}));

import * as consentRoute from "@/app/api/ai/consent/route";

// ===========================================================================
// Finding #1 — Empty provider allowlist must deny all
// ===========================================================================

describe("CORE-03G.2 — Finding 1: empty allowlist denies all", () => {
  let db: ReturnType<typeof getDb>;
  let workspaceIds: string[];

  beforeEach(() => {
    db = getDb();
    const services = getServices();
    const { user } = services.identity.linkAuthAccount("c2-consent", `route:${uuid()}`, {
      displayName: "C2 Consent User",
    });
    workspaceIds = [];
    for (let i = 0; i < 5; i++) {
      const ws = services.workspace.createWorkspace(user.id, "PERSONAL", `C2 WS ${i}`);
      services.workspace.setMembership(ws.id, user.id, "OWNER", ws.id);
      workspaceIds.push(ws.id);
    }
  });

  const w = (i: number) => workspaceIds[i];

  it("denies every external provider when externalAiAllowed is false", () => {
    setConsent(db, w(0), { externalAiAllowed: false, allowedExternalProviderIds: [], consentedBy: "u" });
    expect(() => assertProviderAllowed(db, w(0), "EXTERNAL", "bean.intelligence")).toThrow(ConsentError);
    expect(() => assertProviderAllowed(db, w(0), "EXTERNAL", "any.provider")).toThrow(ConsentError);
  });

  it("denies every external provider when allowlist is empty even if externalAiAllowed is true", () => {
    setConsent(db, w(1), { externalAiAllowed: true, allowedExternalProviderIds: [], consentedBy: "u" });
    expect(() => assertProviderAllowed(db, w(1), "EXTERNAL", "bean.intelligence")).toThrow(ConsentError);
    expect(() => assertProviderAllowed(db, w(1), "EXTERNAL", "openai.compatible")).toThrow(ConsentError);
    // No provider id at all also denies.
    expect(() => assertProviderAllowed(db, w(1), "EXTERNAL")).toThrow(ConsentError);
  });

  it("permits only explicitly allowlisted providers when allowlist is non-empty", () => {
    setConsent(db, w(2), {
      externalAiAllowed: true,
      allowedExternalProviderIds: ["bean.intelligence"],
      consentedBy: "u",
    });
    expect(() => assertProviderAllowed(db, w(2), "EXTERNAL", "bean.intelligence")).not.toThrow();
    expect(() => assertProviderAllowed(db, w(2), "EXTERNAL", "openai.compatible")).toThrow(ConsentError);
  });

  it("denies unknown / non-allowlisted provider ids", () => {
    setConsent(db, w(3), {
      externalAiAllowed: true,
      allowedExternalProviderIds: ["bean.intelligence"],
      consentedBy: "u",
    });
    expect(() => assertProviderAllowed(db, w(3), "EXTERNAL", "unknown.provider")).toThrow(ConsentError);
    expect(() => assertProviderAllowed(db, w(3), "EXTERNAL", "")).toThrow(ConsentError);
  });

  it("denies after consent is revoked", () => {
    setConsent(db, w(4), {
      externalAiAllowed: true,
      allowedExternalProviderIds: ["bean.intelligence"],
      consentedBy: "u",
    });
    expect(() => assertProviderAllowed(db, w(4), "EXTERNAL", "bean.intelligence")).not.toThrow();
    // Revoke.
    setConsent(db, w(4), { externalAiAllowed: false, allowedExternalProviderIds: [], consentedBy: "u" });
    expect(() => assertProviderAllowed(db, w(4), "EXTERNAL", "bean.intelligence")).toThrow(ConsentError);
  });

  it("hasExternalAiConsent reflects effective usability (empty list = not usable)", () => {
    setConsent(db, w(0), { externalAiAllowed: true, allowedExternalProviderIds: [], consentedBy: "u" });
    expect(hasExternalAiConsent(db, w(0))).toBe(false);
    setConsent(db, w(0), { externalAiAllowed: true, allowedExternalProviderIds: ["bean.intelligence"], consentedBy: "u" });
    expect(hasExternalAiConsent(db, w(0))).toBe(true);
    setConsent(db, w(0), { externalAiAllowed: false, allowedExternalProviderIds: ["bean.intelligence"], consentedBy: "u" });
    expect(hasExternalAiConsent(db, w(0))).toBe(false);
  });

  it("internal/local providers remain permitted without consent", () => {
    setConsent(db, w(0), { externalAiAllowed: false, allowedExternalProviderIds: [], consentedBy: "u" });
    expect(() => assertProviderAllowed(db, w(0), "INTERNAL")).not.toThrow();
    expect(() => assertProviderAllowed(db, w(0), "LOCAL")).not.toThrow();
  });
});

describe("CORE-03G.2 — Finding 1: consent API communicates effective usability", () => {
  let services: Services;
  let workspaceId: string;

  beforeAll(() => {
    services = getServices();
    const { user } = services.identity.linkAuthAccount("c2-consent-api", `route:${uuid()}`, {
      displayName: "C2 Consent API User",
    });
    const token = services.session.createSession(user.id, "c2-consent-api");
    mockToken = token.token;
    const ws = services.workspace.createWorkspace(user.id, "PROFESSIONAL", "C2 Consent API WS");
    workspaceId = ws.id;
    services.workspace.setMembership(ws.id, user.id, "OWNER", ws.id);
    // Register an external provider for allowlist validation.
    const { adapter } = createDefaultTestProvider();
    const describe = adapter.describe();
    services.aiProviders.register(
      { ...describe, providerId: "test.external", privacyClass: "EXTERNAL", availabilityStatus: "AVAILABLE", healthStatus: "HEALTHY" },
      adapter,
    );
  });

  const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);

  it("GET reports externalAiUsable=false when allowlist is empty", async () => {
    const res = await consentRoute.PATCH(
      req(`/api/ai/consent?workspaceId=${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalAiAllowed: true, allowedExternalProviderIds: [] }),
      }),
    );
    expect(res.status).toBe(200);
    const get = await consentRoute.GET(req(`/api/ai/consent?workspaceId=${workspaceId}`));
    const data = await get.json();
    expect(data.consent.externalAiAllowed).toBe(true);
    expect(data.consent.externalAiUsable).toBe(false);
  });

  it("GET reports externalAiUsable=true when a provider is allowlisted", async () => {
    const res = await consentRoute.PATCH(
      req(`/api/ai/consent?workspaceId=${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalAiAllowed: true, allowedExternalProviderIds: ["test.external"] }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.consent.externalAiUsable).toBe(true);
  });
});

// ===========================================================================
// Finding #2 — IPv6 and IPv4-mapped IPv6 SSRF classification
// ===========================================================================

describe("CORE-03G.2 — Finding 2: IPv6 / IPv4-mapped IPv6 classification", () => {
  it("blocks IPv4-mapped IPv6 loopback/private/metadata/private", () => {
    expect(isBlockedIp("::ffff:127.0.0.1", false)).toBe(true); // loopback
    expect(isBlockedIp("::ffff:10.0.0.1", false)).toBe(true); // private
    expect(isBlockedIp("::ffff:192.168.1.1", false)).toBe(true); // private
    expect(isBlockedIp("::ffff:172.16.0.1", false)).toBe(true); // private
  });

  it("blocks IPv4-mapped metadata IP UNCONDITIONALLY (even with local allowed)", () => {
    expect(isBlockedIp("::ffff:169.254.169.254", false)).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254", true)).toBe(true); // unconditional
  });

  it("blocks IPv6 loopback and unspecified always", () => {
    expect(isBlockedIp("::1", true)).toBe(true);
    expect(isBlockedIp("::1", false)).toBe(true);
    expect(isBlockedIp("::", true)).toBe(true);
    expect(isBlockedIp("::", false)).toBe(true);
  });

  it("blocks IPv6 link-local and unique-local when local disabled", () => {
    expect(isBlockedIp("fe80::1", false)).toBe(true);
    expect(isBlockedIp("fd00::1", false)).toBe(true);
    expect(isBlockedIp("fc00::1", false)).toBe(true);
    // Non-metadata ranges are allowed when local is enabled.
    expect(isBlockedIp("fe80::1", true)).toBe(false);
    expect(isBlockedIp("fd00::1", true)).toBe(false);
  });

  it("blocks IPv6 multicast always", () => {
    expect(isBlockedIp("ff02::1", true)).toBe(true);
    expect(isBlockedIp("ff02::1", false)).toBe(true);
  });

  it("blocks IPv4 metadata and link-local unconditionally / when local disabled", () => {
    expect(isBlockedIp("169.254.169.254", true)).toBe(true); // unconditional
    expect(isBlockedIp("169.254.169.254", false)).toBe(true);
    expect(isBlockedIp("169.254.1.1", false)).toBe(true); // link-local
    expect(isBlockedIp("100.100.100.200", true)).toBe(true); // metadata unconditional
  });

  it("blocks IPv4 private / loopback when local disabled, allows when enabled", () => {
    expect(isBlockedIp("127.0.0.1", false)).toBe(true);
    expect(isBlockedIp("127.0.0.1", true)).toBe(false);
    expect(isBlockedIp("10.1.2.3", false)).toBe(true);
    expect(isBlockedIp("192.168.1.1", false)).toBe(true);
    expect(isBlockedIp("172.16.0.1", false)).toBe(true);
    expect(isBlockedIp("10.1.2.3", true)).toBe(false);
  });

  it("does not block public IPv4 and IPv6", () => {
    expect(isBlockedIp("8.8.8.8", false)).toBe(false);
    expect(isBlockedIp("8.8.8.8", true)).toBe(false);
    expect(isBlockedIp("203.0.113.10", false)).toBe(false);
    expect(isBlockedIp("2001:db8::1", false)).toBe(false);
    expect(isBlockedIp("2001:db8::1", true)).toBe(false);
    expect(isBlockedIp("::ffff:8.8.8.8", false)).toBe(false); // mapped public
  });

  it("parseIp canonicalises IPv4-mapped IPv6 into 8 groups", () => {
    const parsed = parseIp("::ffff:127.0.0.1");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("v6");
    if (parsed!.kind === "v6") {
      expect(parsed!.groups).toHaveLength(8);
      expect(parsed!.groups[5]).toBe(0xffff); // mapped marker
    }
  });

  it("isIpLiteral recognises IPv4-mapped IPv6 (no string-prefix bypass)", () => {
    expect(isIpLiteral("::ffff:127.0.0.1")).toBe(true);
    expect(isIpLiteral("::ffff:169.254.169.254")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
  });

  it("isBlockedHostname blocks IPv4-mapped IPv6 literals pre-DNS", () => {
    expect(isBlockedHostname("::ffff:127.0.0.1", false)).toBe(true);
    expect(isBlockedHostname("::ffff:169.254.169.254", false)).toBe(true);
    expect(isBlockedHostname("::ffff:169.254.169.254", true)).toBe(true); // unconditional
  });

  it("isMetadataHost still blocks metadata hostnames unconditionally", () => {
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
    expect(isMetadataHost("instance-data")).toBe(true);
  });
});

// ===========================================================================
// Finding #4 — Fallback routing enforces full eligibility
// ===========================================================================

describe("CORE-03G.2 — Finding 4: fallback routing full eligibility", () => {
  function buildRegistry() {
    const db = getDb();
    db.prepare("DELETE FROM ai_models").run();
    db.prepare("DELETE FROM ai_providers").run();
    const providers = new ProviderRegistry(db);
    const models = new ModelRegistry(db);
    const { adapter } = createDefaultTestProvider();
    const describe = adapter.describe();
    providers.register(
      { ...describe, providerId: "fb.test", availabilityStatus: "AVAILABLE", healthStatus: "HEALTHY" },
      adapter,
    );
    return { db, providers, models };
  }

  function modelMeta(opts: {
    modelId: string;
    task?: TaskCategory;
    status?: "AVAILABLE" | "DISABLED";
    evidence?: string | null;
    privacy?: "INTERNAL" | "EXTERNAL";
    structuredOutput?: boolean;
  }): ModelMetadata {
    return {
      modelId: opts.modelId,
      providerId: "fb.test",
      modelName: "FB Model",
      modelVersion: "1",
      supportedTasks: [opts.task ?? "TRANSLATION"] as TaskCategory[],
      supportedModalities: ["text"] as Modality[],
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      structuredOutput: opts.structuredOutput ?? false,
      structuredOutputMode: "NONE",
      toolCall: false,
      streaming: true,
      reasoning: false,
      latencyMetadata: null,
      costMetadata: null,
      privacyClass: opts.privacy ?? "INTERNAL",
      status: opts.status ?? "AVAILABLE",
      availabilityEvidence:
        opts.evidence === undefined ? "health-check-passed" : opts.evidence,
    };
  }

  const constraints: RoutingConstraints = {
    taskCategory: "TRANSLATION",
    requiredModalities: ["text"],
    requireStructuredOutput: false,
    requireToolCall: false,
    requireReasoning: false,
  };

  it("fallback excludes a model when provider availability is stale but health is FAILING", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta({ modelId: "m1" }));
    providers.setStatus("fb.test", "AVAILABLE", "FAILING"); // stale availability, failing health
    const router = new ModelRouter(providers, models);
    expect(router.fallbackChain(constraints)).toHaveLength(0);
    expect(() => router.route(constraints)).toThrow(RoutingError);
  });

  it("fallback excludes a model when provider availability is stale but health is UNAVAILABLE", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta({ modelId: "m1" }));
    providers.setStatus("fb.test", "AVAILABLE", "UNAVAILABLE");
    const router = new ModelRouter(providers, models);
    expect(router.fallbackChain(constraints)).toHaveLength(0);
  });

  it("fallback excludes disabled models", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta({ modelId: "m1", status: "DISABLED" }));
    const router = new ModelRouter(providers, models);
    expect(router.fallbackChain(constraints)).toHaveLength(0);
  });

  it("fallback excludes models without availability evidence", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta({ modelId: "m1", evidence: null }));
    const router = new ModelRouter(providers, models);
    expect(router.fallbackChain(constraints)).toHaveLength(0);
  });

  it("fallback excludes providers violating privacy constraints", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta({ modelId: "m1", privacy: "EXTERNAL" }));
    const router = new ModelRouter(providers, models);
    const chain = router.fallbackChain({ ...constraints, privacyClass: "INTERNAL" });
    expect(chain).toHaveLength(0);
  });

  it("fallback excludes models lacking required capabilities", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta({ modelId: "m1", structuredOutput: false }));
    const router = new ModelRouter(providers, models);
    const chain = router.fallbackChain({ ...constraints, requireStructuredOutput: true });
    expect(chain).toHaveLength(0);
  });

  it("fallback excludes the test provider in production", () => {
    const env = process.env as { NODE_ENV: string };
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const { providers, models } = buildRegistry();
      // The provider adapter is the test adapter; mark it as such.
      models.register(modelMeta({ modelId: "m1" }));
      const router = new ModelRouter(providers, models);
      expect(router.fallbackChain(constraints)).toHaveLength(0);
      expect(() => router.route(constraints)).toThrow(RoutingError);
    } finally {
      env.NODE_ENV = prev;
    }
  });

  it("fallback includes an eligible model when all checks pass", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta({ modelId: "m1" }));
    const router = new ModelRouter(providers, models);
    expect(router.fallbackChain(constraints)).toHaveLength(1);
    expect(router.fallbackChain(constraints)[0].modelId).toBe("m1");
  });
});

// ===========================================================================
// Finding #5 — Streaming idle timeout and resource cleanup
// ===========================================================================

describe("CORE-03G.2 — Finding 5: stream idle timeout & cleanup", () => {
  let sockets: Set<import("node:net").Socket>;

  beforeEach(() => {
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS = "1";
    sockets = new Set();
  });

  afterEach(() => {
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
    delete process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS;
  });

  function startServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        req.resume(); // drain the request body so the response can flow
        handler(req, res);
      });
      server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({ server, port });
      });
    });
  }

  function stop(server: http.Server) {
    return new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  it("slow-but-active stream succeeds within the idle timeout", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write("data: first\n\n");
      setTimeout(() => res.write("data: second\n\n"), 20);
      setTimeout(() => {
        res.write("data: [DONE]\n\n");
        res.end();
      }, 40);
    });
    try {
      const iterable = await httpSSEStream(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {},
        body: {},
        idleTimeoutMs: 500,
        timeoutMs: 2000,
      });
      const chunks: string[] = [];
      for await (const c of iterable) chunks.push(new TextDecoder().decode(c));
      const text = chunks.join("");
      expect(text).toContain("first");
      expect(text).toContain("second");
      expect(text).toContain("[DONE]");
    } finally {
      await stop(server);
    }
  });

  it("stalled stream is aborted by the idle timeout (TIMEOUT, not ABORTED)", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      // Never send any data; keep the connection open.
    });
    try {
      const iterable = await httpSSEStream(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {},
        body: {},
        idleTimeoutMs: 100,
        timeoutMs: 2000,
      });
      let error: unknown;
      try {
        for await (const _c of iterable) {
          /* no data expected */
        }
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ProviderHTTPError);
      expect((error as ProviderHTTPError).code).toBe("TIMEOUT");
    } finally {
      await stop(server);
    }
  });

  it("caller AbortSignal aborts the stream (distinct from timeout)", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      // Never send data.
    });
    try {
      const controller = new AbortController();
      const iterable = await httpSSEStream(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {},
        body: {},
        signal: controller.signal,
        idleTimeoutMs: 5000,
        timeoutMs: 2000,
      });
      const it = iterable[Symbol.asyncIterator]();
      const nextPromise = it.next(); // pending: no data
      controller.abort();
      let error: unknown;
      try {
        await nextPromise;
      } catch (e) {
        error = e;
      }
      expect(controller.signal.aborted).toBe(true);
      expect(error).toBeInstanceOf(ProviderHTTPError);
      expect((error as ProviderHTTPError).code).toBe("ABORTED");
    } finally {
      await stop(server);
    }
  });

  it("early iterator return destroys the response and terminates cleanly", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write("data: chunk1\n\n");
      // Then stall (never end).
    });
    try {
      const iterable = await httpSSEStream(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {},
        body: {},
        idleTimeoutMs: 5000,
        timeoutMs: 2000,
      });
      const it = iterable[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value).toBeTruthy();
      // Early termination: return() must resolve and mark done.
      const ret = await it.return?.();
      expect(ret?.done ?? true).toBe(true);
      const after = await it.next();
      expect(after.done).toBe(true);
      // The upstream response socket should be destroyed shortly.
      await new Promise((r) => setTimeout(r, 50));
      expect(sockets.size).toBe(0);
    } finally {
      await stop(server);
    }
  });
});
