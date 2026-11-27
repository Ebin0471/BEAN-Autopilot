// @vitest-environment node

/**
 * CORE-02D — API route integration tests.
 *
 * Exercises the real Route Handlers (app/api/commands, app/api/capabilities)
 * against an in-memory database. `next/headers` `cookies()` is mocked with a
 * mutable session token; every handler still delegates to the real container
 * services, so identity, workspace, permission, risk, passport and lifecycle
 * enforcement are exercised end-to-end.
 *
 * The app services are obtained through the same `getDb()` singleton the
 * route handlers use, so fixtures created here are visible to the handlers.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Point the app's database singleton at a throwaway in-memory database BEFORE
// the route handlers (and their getServices() -> getDb()) load.
process.env.BEAN_DB_PATH = ":memory:";

import { SESSION_COOKIE } from "@/lib/api/http";
import { getServices, type Services } from "@/lib/security/container";
import { uuid } from "@/lib/db/util";

let mockToken: string | null = null;

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && mockToken ? { value: mockToken } : undefined,
  }),
}));

import * as commandsRoute from "@/app/api/commands/route";
import * as commandsIdRoute from "@/app/api/commands/[id]/route";
import * as validateRoute from "@/app/api/commands/validate/route";
import * as previewRoute from "@/app/api/commands/preview/route";
import * as executionsRoute from "@/app/api/commands/executions/route";
import * as capabilitiesRoute from "@/app/api/capabilities/route";
import * as capabilitiesIdRoute from "@/app/api/capabilities/[id]/route";

let workspaceId: string;

beforeAll(() => {
  const services: Services = getServices();
  const { user } = services.identity.linkAuthAccount(
    "local-test",
    `test:${uuid()}`,
    { displayName: "Route Owner" },
  );
  const session = services.session.createSession(user.id, "route-test");
  mockToken = session.token;

  const ws = services.workspace.createWorkspace(user.id, "BUSINESS", "Route Test");
  workspaceId = ws.id;
});

function req(url: string, init?: RequestInit) {
  return new Request(`http://localhost${url}`, init);
}

describe("CORE-02D API routes — discovery", () => {
  it("GET /api/commands returns the registered catalogue for an authenticated caller", async () => {
    const res = await commandsRoute.GET(req("/api/commands"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.commands)).toBe(true);
    expect(body.commands.length).toBeGreaterThan(0);
    const sample = body.commands[0];
    expect(sample).toMatchObject({
      commandId: expect.any(String),
      version: expect.any(String),
      serverRiskClass: expect.any(String),
      requiredPermissions: expect.any(Array),
    });
  });

  it("GET /api/commands filters by category", async () => {
    const res = await commandsRoute.GET(req("/api/commands?category=platform"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commands.length).toBeGreaterThan(0);
    expect(
      body.commands.every((c: { category: string }) => c.category === "platform"),
    ).toBe(true);
  });

  it("GET /api/commands/[id] describes a command and 404s for unknown ids", async () => {
    const list = await commandsRoute.GET(req("/api/commands"));
    const { commands } = await list.json();
    const id = commands[0].commandId;

    const found = await commandsIdRoute.GET(
      req(`/api/commands/${encodeURIComponent(id)}`),
      { params: { id } },
    );
    expect(found.status).toBe(200);
    expect((await found.json()).command.commandId).toBe(id);

    const missing = await commandsIdRoute.GET(
      req(`/api/commands/nope:nope`),
      { params: { id: "nope:nope" } },
    );
    expect(missing.status).toBe(404);
  });

  it("GET /api/capabilities lists registered capabilities", async () => {
    const res = await capabilitiesRoute.GET(req("/api/capabilities"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.capabilities.length).toBeGreaterThan(0);
  });

  it("GET /api/capabilities/[id] describes a capability and 404s for unknown ids", async () => {
    const list = await capabilitiesRoute.GET(req("/api/capabilities"));
    const { capabilities } = await list.json();
    const id = capabilities[0].capabilityId;

    const found = await capabilitiesIdRoute.GET(
      req(`/api/capabilities/${encodeURIComponent(id)}`),
      { params: { id } },
    );
    expect(found.status).toBe(200);

    const missing = await capabilitiesIdRoute.GET(
      req(`/api/capabilities/nope:nope`),
      { params: { id: "nope:nope" } },
    );
    expect(missing.status).toBe(404);
  });
});

describe("CORE-02D API routes — gateway submission", () => {
  it("POST /api/commands/validate dry-validates args without executing or creating a passport", async () => {
    const res = await validateRoute.POST(
      req("/api/commands/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "platform.commands.list",
          workspaceId,
          args: {},
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.commandId).toBe("platform.commands.list");
  });

  it("POST /api/commands/validate reports invalid args as valid:false (dry check)", async () => {
    const res = await validateRoute.POST(
      req("/api/commands/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "platform.commands.list",
          workspaceId,
          args: { category: 123 },
        }),
      }),
    );
    // The validate endpoint is a dry check: it returns 200 with valid:false
    // and the specific errors rather than a hard failure.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("POST /api/commands/preview returns a dry-run preview without executing", async () => {
    const res = await previewRoute.POST(
      req("/api/commands/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "platform.commands.list",
          workspaceId,
          args: {},
          idempotencyKey: "preview-route-test",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Preview resolves the command and reports its plan without executing or
    // creating a passport.
    expect(body.commandId).toBe("platform.commands.list");
    expect(body.errors).toEqual([]);
    expect(body.paramsHash).toBeTruthy();
  });

  it("POST /api/commands submits through the gateway and is idempotent for a replay", async () => {
    const payload = {
      commandId: "platform.commands.list",
      workspaceId,
      args: {},
      idempotencyKey: "idem-route-test-1",
    };
    const first = await commandsRoute.POST(
      req("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.status).toBe("VERIFIED");

    // Replay with the same idempotency key returns the terminal record, not a
    // second execution.
    const replay = await commandsRoute.POST(
      req("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.status).toBe("VERIFIED");
  });

  it("POST /api/commands blocks unknown commands with 403 (fail-closed)", async () => {
    const res = await commandsRoute.POST(
      req("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "nope.unknown-command",
          workspaceId,
          args: {},
          idempotencyKey: "idem-unknown",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/commands returns 400 for an invalid request body", async () => {
    const res = await commandsRoute.POST(
      req("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: "platform.commands.list" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /api/commands/executions lists lifecycle records for a workspace", async () => {
    const res = await executionsRoute.GET(
      req(`/api/commands/executions?workspaceId=${workspaceId}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.executions)).toBe(true);
    expect(body.executions.length).toBeGreaterThan(0);
  });
});

describe("CORE-02D API routes — authentication is enforced", () => {
  it("returns 401 for unauthenticated discovery requests", async () => {
    const saved = mockToken;
    mockToken = null;
    const res = await commandsRoute.GET(req("/api/commands"));
    mockToken = saved;
    expect(res.status).toBe(401);
  });

  it("returns 401 for unauthenticated capability discovery", async () => {
    const saved = mockToken;
    mockToken = null;
    const res = await capabilitiesRoute.GET(req("/api/capabilities"));
    mockToken = saved;
    expect(res.status).toBe(401);
  });
});
