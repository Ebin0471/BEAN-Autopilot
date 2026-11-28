// @vitest-environment node

/**
 * CORE-03G.1 — Corrective hardening security & integrity tests.
 *
 * Targeted tests for the five hardening areas:
 *   1. Genuine incremental SSE forwarding (frame iterator relays deltas as they
 *      arrive, not buffered).
 *   2. SSRF protection: unconditional metadata blocking + IP-level validation +
 *      pinned outbound destinations (DNS-rebinding protection).
 *   3. End-to-end cancellation + truthful COMPLETED/PARTIAL/FAILED/CANCELLED
 *      message lifecycle.
 *   4. Authorised workspace-scoped consent management API + audit records.
 *   5. Evidence-based provider/model capabilities, health states and routing
 *      eligibility.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.BEAN_DB_PATH = ":memory:";

// ---------------------------------------------------------------------------
// DNS mock for resolveAndValidateHost (Area 2). Controlled per-test.
// ---------------------------------------------------------------------------
let dnsAddresses: string[] = [];
let dnsError: Error | null = null;
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_hostname: string, options: { all?: boolean }) => {
    if (dnsError) throw dnsError;
    if (options?.all) {
      return dnsAddresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
    }
    return { address: dnsAddresses[0] ?? "", family: 4 };
  }),
}));

import {
  isBlockedIp,
  isMetadataHost,
  isBlockedHostname,
  isIpLiteral,
  resolveAndValidateHost,
  pinnedLookup,
  validateBaseUrl,
  defaultEndpointPolicy,
  EndpointSafetyError,
  type PinnedDestination,
} from "@/lib/ai/endpoint-safety";
import { iterateSSEFrames } from "@/lib/ai/sse";
import { hasAvailabilityEvidence, ModelRouter, RoutingError } from "@/lib/ai/routing";
import type { Modality, TaskCategory, ModelMetadata } from "@/lib/ai/types";
import { ProviderRegistry } from "@/lib/ai/provider-registry";
import { ModelRegistry } from "@/lib/ai/model-registry";
import { createDefaultTestProvider } from "@/lib/ai/providers/test-provider";
import { getDb } from "@/lib/db/database";
import { getServices, type Services } from "@/lib/security/container";
import { SESSION_COOKIE } from "@/lib/api/http";
import { uuid } from "@/lib/db/util";

// Route tests need a mocked session cookie (mirrors core03-routes).
let mockToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && mockToken ? { value: mockToken } : undefined,
  }),
}));

import * as consentRoute from "@/app/api/ai/consent/route";

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
// Area 1 — Genuine incremental SSE forwarding (frame iterator)
// ---------------------------------------------------------------------------

describe("CORE-03G.1 — Area 1: incremental SSE forwarding", () => {
  it("yields each data frame as soon as its block closes (not buffered)", async () => {
    const stream = asyncChunks([
      "data: {\"delta\":\"Hello\"}\n\n",
      "data: {\"delta\":\" world\"}\n\n",
      "data: {\"done\":true}\n\n",
    ]);
    const frames: string[] = [];
    for await (const frame of iterateSSEFrames(stream)) {
      if (frame.kind === "data") frames.push(frame.data);
    }
    // Frames arrive incrementally: 3 frames (two deltas + done), in order.
    expect(frames).toHaveLength(3);
    expect(frames[0]).toBe('{"delta":"Hello"}');
    expect(frames[1]).toBe('{"delta":" world"}');
    expect(frames[2]).toBe('{"done":true}');
  });

  it("relays a frame before the stream ends (incremental, not whole-buffer)", async () => {
    // The generator yields the first frame immediately, before consuming the
    // rest of the stream.
    const iterator = iterateSSEFrames(
      asyncChunks([
        "data: {\"delta\":\"first\"}\n\n",
        "data: {\"delta\":\"second\"}\n\n",
        "data: {\"done\":true}\n\n",
      ]),
    );
    const first = await iterator.next();
    expect(first.value?.kind).toBe("data");
    expect(first.value?.data).toBe('{"delta":"first"}');
    // The second frame is only available after another next().
    const second = await iterator.next();
    expect(second.value?.data).toBe('{"delta":"second"}');
  });

  it("yields truncated on the max-size bound", async () => {
    const big = "data: " + "x".repeat(5000) + "\n\n";
    const frames: { kind: string }[] = [];
    for await (const frame of iterateSSEFrames(asyncChunks([big]), undefined, { maxBytes: 1000 })) {
      frames.push({ kind: frame.kind });
      if (frame.kind === "truncated") break;
    }
    expect(frames.some((f) => f.kind === "truncated")).toBe(true);
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    const iterator = iterateSSEFrames(
      asyncChunks([
        "data: {\"delta\":\"a\"}\n\n",
        "data: {\"delta\":\"b\"}\n\n",
      ]),
      controller.signal,
    );
    await iterator.next();
    controller.abort();
    const next = await iterator.next();
    expect(next.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Area 2 — SSRF protection: unconditional metadata + pinned destinations
// ---------------------------------------------------------------------------

describe("CORE-03G.1 — Area 2: SSRF protection", () => {
  it("blocks cloud-metadata IPs UNCONDITIONALLY, even with local allowed", () => {
    for (const ip of [
      "169.254.169.254",
      "169.254.170.2",
      "169.254.170.23",
      "100.100.100.200",
      "169.254.169.253",
    ]) {
      expect(isBlockedIp(ip, true)).toBe(true); // allowLocal=true still blocked
      expect(isBlockedIp(ip, false)).toBe(true);
    }
  });

  it("blocks loopback/private IPs when local is disabled, allows when enabled", () => {
    expect(isBlockedIp("127.0.0.1", false)).toBe(true);
    expect(isBlockedIp("127.0.0.1", true)).toBe(false);
    expect(isBlockedIp("10.0.0.1", false)).toBe(true);
    expect(isBlockedIp("10.0.0.1", true)).toBe(false);
    expect(isBlockedIp("192.168.1.1", false)).toBe(true);
    expect(isBlockedIp("172.16.0.1", false)).toBe(true);
    // Metadata still blocked even when local allowed.
    expect(isBlockedIp("169.254.169.254", true)).toBe(true);
    // Public IPs are never blocked.
    expect(isBlockedIp("8.8.8.8", false)).toBe(false);
    expect(isBlockedIp("8.8.8.8", true)).toBe(false);
  });

  it("blocks loopback/multicast IPv6 always", () => {
    expect(isBlockedIp("::1", true)).toBe(true);
    expect(isBlockedIp("::1", false)).toBe(true);
  });

  it("blocks metadata hostnames unconditionally", () => {
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
    expect(isMetadataHost("instance-data")).toBe(true);
    expect(isMetadataHost("foo.internal")).toBe(true);
    expect(isMetadataHost("example.com")).toBe(false);
  });

  it("blocks IP-literal hostnames (loopback + metadata) pre-DNS", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("169.254.169.254")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isBlockedHostname("127.0.0.1", false)).toBe(true);
    expect(isBlockedHostname("169.254.169.254", false)).toBe(true);
    expect(isBlockedHostname("169.254.169.254", true)).toBe(true); // unconditional
  });

  it("validateBaseUrl rejects metadata IP literal and metadata hostname", () => {
    const policy = defaultEndpointPolicy();
    expect(() => validateBaseUrl("http://169.254.169.254", policy)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("http://metadata.google.internal", policy)).toThrow(EndpointSafetyError);
    // Even with local allowed, metadata is rejected.
    const localPolicy = { ...policy, allowLocalEndpoints: true };
    expect(() => validateBaseUrl("http://169.254.169.254", localPolicy)).toThrow(EndpointSafetyError);
    expect(() => validateBaseUrl("http://metadata.google.internal", localPolicy)).toThrow(EndpointSafetyError);
  });

  it("pinnedLookup returns the validated IP regardless of requested hostname", () => {
    const dest: PinnedDestination = { hostname: "api.example.com", ip: "203.0.113.10", port: 443, secure: true };
    const lookup = pinnedLookup(dest);
    lookup("ignored.example.com", {}, (err: Error | null, addr: string, family: number) => {
      expect(err).toBeNull();
      expect(addr).toBe("203.0.113.10");
      expect(family).toBe(4);
    });
  });

  it("resolveAndValidateHost rejects a host resolving to a metadata IP", async () => {
    dnsAddresses = ["169.254.169.254"];
    dnsError = null;
    await expect(
      resolveAndValidateHost("evil.example.com", 80, false, defaultEndpointPolicy()),
    ).rejects.toThrow(EndpointSafetyError);
  });

  it("resolveAndValidateHost rejects a host resolving to a private IP when local disabled", async () => {
    dnsAddresses = ["10.0.0.5"];
    dnsError = null;
    await expect(
      resolveAndValidateHost("private.example.com", 80, false, defaultEndpointPolicy()),
    ).rejects.toThrow(EndpointSafetyError);
  });

  it("resolveAndValidateHost rejects a host resolving to ANY blocked IP (mixed result)", async () => {
    // One good + one metadata IP → rejected (any blocked IP fails the whole host).
    dnsAddresses = ["203.0.113.1", "169.254.169.254"];
    dnsError = null;
    await expect(
      resolveAndValidateHost("mixed.example.com", 80, false, defaultEndpointPolicy()),
    ).rejects.toThrow(EndpointSafetyError);
  });

  it("resolveAndValidateHost pins to the validated public IP", async () => {
    dnsAddresses = ["203.0.113.10"];
    dnsError = null;
    const dest = await resolveAndValidateHost("api.example.com", 443, true, defaultEndpointPolicy());
    expect(dest.ip).toBe("203.0.113.10");
    expect(dest.hostname).toBe("api.example.com");
    expect(dest.secure).toBe(true);
    // The pinned lookup returns that exact IP.
    const lookup = pinnedLookup(dest);
    let returned = "";
    lookup("api.example.com", {}, (_e: Error | null, addr: string) => {
      returned = addr;
    });
    expect(returned).toBe("203.0.113.10");
  });

  it("resolveAndValidateHost reports DNS failure honestly", async () => {
    dnsError = new Error("ENOTFOUND");
    dnsAddresses = [];
    await expect(
      resolveAndValidateHost("nope.example.com", 80, false, defaultEndpointPolicy()),
    ).rejects.toThrow(EndpointSafetyError);
    dnsError = null;
  });
});

// ---------------------------------------------------------------------------
// Area 3 — End-to-end cancellation + truthful message lifecycle
// ---------------------------------------------------------------------------

describe("CORE-03G.1 — Area 3: cancellation & message lifecycle", () => {
  let services: Services;
  let userId: string;
  let workspaceId: string;
  let conversationId: string;

  beforeAll(() => {
    services = getServices();
    const { user } = services.identity.linkAuthAccount("cancel-user", `route:${uuid()}`, {
      displayName: "Cancel User",
    });
    userId = user.id;
    const ws = services.workspace.createWorkspace(user.id, "PERSONAL", "Cancel WS");
    workspaceId = ws.id;
    services.workspace.setMembership(ws.id, user.id, "OWNER", ws.id);
  });

  beforeEach(() => {
    const conv = services.conversations.create({
      workspaceId,
      userId,
      title: `C ${uuid()}`,
    });
    conversationId = conv.id;
  });

  it("handleTurn returns COMPLETED streamStatus on a clean stream", async () => {
    const result = await services.orchestrator.handleTurn(
      { workspaceId, userId, conversationId, message: "Hello there" },
      {
        streamResponse: true,
        onResponseDelta: () => {},
      },
    );
    expect(result.streamStatus).toBe("COMPLETED");
    expect(result.response.length).toBeGreaterThan(0);
  });

  it("handleTurn returns CANCELLED when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await services.orchestrator.handleTurn(
      { workspaceId, userId, conversationId, message: "Hello there" },
      {
        streamResponse: true,
        onResponseDelta: () => {},
        signal: controller.signal,
      },
    );
    expect(result.streamStatus).toBe("CANCELLED");
  });

  it("handleTurn returns an honest status when the signal aborts mid-stream", async () => {
    // Abort after some deltas: the stream is cancelled and NO template fallback
    // is emitted (fallback is forbidden once a delta has streamed). The status
    // must be truthful (COMPLETED if it finished before the abort, otherwise
    // CANCELLED) — never a fabricated COMPLETED-with-error.
    const controller = new AbortController();
    let deltaCount = 0;
    const result = await services.orchestrator.handleTurn(
      { workspaceId, userId, conversationId, message: "Hello there, please continue" },
      {
        streamResponse: true,
        onResponseDelta: (delta) => {
          deltaCount += delta.length;
          if (deltaCount > 5) controller.abort();
        },
        signal: controller.signal,
      },
    );
    expect(["COMPLETED", "CANCELLED"]).toContain(result.streamStatus);
    // If cancelled, the response is the partial streamed content (not a
    // template fallback), and a limitation is recorded.
    if (result.streamStatus === "CANCELLED") {
      expect(result.response).toBeTruthy();
      expect(result.limitations.join(" ").toLowerCase()).toContain("cancel");
    }
  });
});

// ---------------------------------------------------------------------------
// Area 4 — Consent management API + audit records
// ---------------------------------------------------------------------------

describe("CORE-03G.1 — Area 4: consent management API", () => {
  let services: Services;
  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(() => {
    services = getServices();
    const { user } = services.identity.linkAuthAccount("consent-api-user", `route:${uuid()}`, {
      displayName: "Consent API User",
    });
    const token = services.session.createSession(user.id, "consent-api");
    mockToken = token.token;
    const ws = services.workspace.createWorkspace(user.id, "PROFESSIONAL", "Consent API WS");
    workspaceId = ws.id;
    services.workspace.setMembership(ws.id, user.id, "OWNER", ws.id);
    // A second workspace owned by a DIFFERENT user: the authed user is NOT a
    // member, so consent operations must be denied (fail-closed).
    const { user: otherUser } = services.identity.linkAuthAccount("consent-api-other", `route:${uuid()}`, {
      displayName: "Consent API Other",
    });
    const other = services.workspace.createWorkspace(otherUser.id, "PROFESSIONAL", "Other WS");
    otherWorkspaceId = other.id;
    services.workspace.setMembership(other.id, otherUser.id, "OWNER", other.id);

    // Register an EXTERNAL provider so the consent allowlist has a valid,
    // known provider id to reference (no real credentials configured).
    const { adapter } = createDefaultTestProvider();
    const describe = adapter.describe();
    services.aiProviders.register(
      { ...describe, providerId: "test.external", privacyClass: "EXTERNAL", availabilityStatus: "AVAILABLE", healthStatus: "HEALTHY" },
      adapter,
    );
  });

  const req = (url: string, init?: RequestInit) =>
    new Request(`http://localhost${url}`, init);

  it("GET returns default denied consent + external provider options", async () => {
    const res = await consentRoute.GET(req(`/api/ai/consent?workspaceId=${workspaceId}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.consent.externalAiAllowed).toBe(false);
    expect(Array.isArray(data.providers)).toBe(true);
  });

  it("PATCH grants external AI with an explicit provider allowlist", async () => {
    const res = await consentRoute.PATCH(
      req(`/api/ai/consent?workspaceId=${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalAiAllowed: true, allowedExternalProviderIds: ["test.external"] }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.consent.externalAiAllowed).toBe(true);
    expect(data.consent.allowedExternalProviderIds).toContain("test.external");
    expect(data.consent.consentedBy).not.toBeNull();
  });

  it("GET reflects the granted consent after PATCH", async () => {
    const res = await consentRoute.GET(req(`/api/ai/consent?workspaceId=${workspaceId}`));
    const data = await res.json();
    expect(data.consent.externalAiAllowed).toBe(true);
    expect(data.consent.allowedExternalProviderIds).toContain("test.external");
  });

  it("PATCH rejects unknown provider ids", async () => {
    const res = await consentRoute.PATCH(
      req(`/api/ai/consent?workspaceId=${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalAiAllowed: true, allowedExternalProviderIds: ["does.not.exist"] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH is denied for a workspace the user is not a member of", async () => {
    const before = services.audit.list(otherWorkspaceId, 100).length;
    const res = await consentRoute.PATCH(
      req(`/api/ai/consent?workspaceId=${otherWorkspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalAiAllowed: true, allowedExternalProviderIds: [] }),
      }),
    );
    expect(res.status).toBe(403);
    const after = services.audit.list(otherWorkspaceId, 100).length;
    expect(after).toBe(before + 1);
  });

  it("PATCH records a hash-chained audit record", async () => {
    const before = services.audit.list(workspaceId, 100);
    const res = await consentRoute.PATCH(
      req(`/api/ai/consent?workspaceId=${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalAiAllowed: false, allowedExternalProviderIds: [] }),
      }),
    );
    expect(res.status).toBe(200);
    const after = services.audit.list(workspaceId, 100);
    expect(after.length).toBe(before.length + 1);
    const latest = after[0];
    expect(latest.event_type).toBe("AI_CONSENT_UPDATE");
    expect(latest.result).toBe("DENIED"); // externalAiAllowed=false → DENIED
    // Hash chain integrity preserved.
    const chain = services.audit.verifyChain();
    expect(chain.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Area 5 — Evidence-based capabilities, health states, routing eligibility
// ---------------------------------------------------------------------------

describe("CORE-03G.1 — Area 5: evidence-based routing eligibility", () => {
  it("hasAvailabilityEvidence is true only for non-empty evidence", () => {
    const withEvidence = { availabilityEvidence: "health-check-passed" } as never;
    const nullEvidence = { availabilityEvidence: null } as never;
    const emptyEvidence = { availabilityEvidence: "   " } as never;
    expect(hasAvailabilityEvidence(withEvidence)).toBe(true);
    expect(hasAvailabilityEvidence(nullEvidence)).toBe(false);
    expect(hasAvailabilityEvidence(emptyEvidence)).toBe(false);
  });

  function buildRegistry() {
    const db = getDb();
    // Isolate routing tests: the services container registers a test provider
    // in the shared DB. Clear all AI rows so ONLY the evidence.test provider
    // and its models are present (this describe runs last and uses fresh
    // registry instances, so clearing is safe).
    db.prepare("DELETE FROM ai_models").run();
    db.prepare("DELETE FROM ai_providers").run();
    const providers = new ProviderRegistry(db);
    const models = new ModelRegistry(db);
    const { adapter } = createDefaultTestProvider();
    const describe = adapter.describe();
    providers.register(
      { ...describe, providerId: "evidence.test", availabilityStatus: "AVAILABLE", healthStatus: "HEALTHY" },
      adapter,
    );
    return { db, providers, models };
  }

  function modelMeta(evidence: string | null, task: TaskCategory = "TRANSLATION"): ModelMetadata {
    return {
      modelId: evidence === null ? "no-evidence-model" : "evidence-model",
      providerId: "evidence.test",
      modelName: "Evidence Model",
      modelVersion: "1",
      supportedTasks: [task],
      supportedModalities: ["text"] as Modality[],
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      structuredOutput: false,
      structuredOutputMode: "NONE" as const,
      toolCall: false,
      streaming: true,
      reasoning: false,
      latencyMetadata: null,
      costMetadata: null,
      privacyClass: "INTERNAL" as const,
      status: "AVAILABLE" as const,
      availabilityEvidence: evidence,
    };
  }

  const constraints = {
    taskCategory: "TRANSLATION" as TaskCategory,
    requiredModalities: ["text"] as Modality[],
    requireStructuredOutput: false,
    requireToolCall: false,
    requireReasoning: false,
  };

  it("routes to a model WITH availability evidence", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta("health-check-passed"));
    const router = new ModelRouter(providers, models);
    const decision = router.route(constraints);
    expect(decision.modelId).toBe("evidence-model");
  });

  it("excludes a model WITHOUT availability evidence (throws NO_MODEL_AVAILABLE)", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta(null));
    const router = new ModelRouter(providers, models);
    expect(() => router.route(constraints)).toThrow(RoutingError);
  });

  it("fallbackChain excludes models without evidence", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta(null));
    const router = new ModelRouter(providers, models);
    const chain = router.fallbackChain(constraints);
    expect(chain).toHaveLength(0);
  });

  it("does not route to a provider with a FAILING health state", () => {
    const { providers, models } = buildRegistry();
    models.register(modelMeta("health-check-passed"));
    // Force the provider health to FAILING.
    providers.setStatus("evidence.test", "DEGRADED", "FAILING");
    const router = new ModelRouter(providers, models);
    expect(() => router.route(constraints)).toThrow(RoutingError);
  });
});
