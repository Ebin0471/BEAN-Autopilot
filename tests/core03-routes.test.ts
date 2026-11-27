// @vitest-environment node

/**
 * CORE-03 — API route integration tests.
 *
 * Exercises the real CORE-03 route handlers (app/api/ai/*) against an
 * in-memory database. `next/headers` `cookies()` is mocked with a mutable
 * session token; every handler delegates to the real container services, so
 * identity, workspace, policy, intent, planning, conversation and orchestration
 * enforcement are exercised end-to-end.
 *
 * The deterministic test provider supplies valid structured intent/plan output
 * so the full pipeline runs without a real AI provider.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

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

import * as providersRoute from "@/app/api/ai/providers/route";
import * as conversationsRoute from "@/app/api/ai/conversations/route";
import * as conversationsIdRoute from "@/app/api/ai/conversations/[id]/route";
import * as messagesRoute from "@/app/api/ai/conversations/[id]/messages/route";
import * as chatRoute from "@/app/api/ai/chat/route";
import * as intentRoute from "@/app/api/ai/intent/route";
import * as planRoute from "@/app/api/ai/plan/route";
import * as agentsRoute from "@/app/api/ai/agents/route";

let services: Services;
let userId: string;
let workspaceId: string;
let conversationId: string;

beforeAll(() => {
  services = getServices();
  const { user } = services.identity.linkAuthAccount("local-test", `route:${uuid()}`, {
    displayName: "AI Route User",
  });
  userId = user.id;
  const session = services.session.createSession(user.id, "ai-routes");
  mockToken = session.token;
  const ws = services.workspace.createWorkspace(user.id, "PROFESSIONAL", "AI Routes");
  workspaceId = ws.id;
  services.workspace.setMembership(ws.id, user.id, "OWNER", ws.id);
});

beforeEach(() => {
  const conv = services.conversations.create({
    workspaceId,
    userId,
    title: `Conv ${uuid()}`,
  });
  conversationId = conv.id;
});

function req(url: string, init?: RequestInit) {
  return new Request(`http://localhost${url}`, init);
}

async function readNdjson(res: Response): Promise<{ type: string }[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("CORE-03 routes — authentication", () => {
  it("returns 401 when not authenticated", async () => {
    mockToken = null;
    const res = await providersRoute.GET();
    expect(res.status).toBe(401);
    mockToken = services.session.createSession(userId, "restore").token;
  });
});

describe("CORE-03 routes — providers", () => {
  it("GET /api/ai/providers lists providers without secrets", async () => {
    const res = await providersRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("apiKey");
    expect(serialised).not.toContain("api_key");
    expect(serialised).not.toContain("secret");
    const test = body.providers.find((p: { providerId: string }) => p.providerId === "test.provider");
    expect(test).toBeTruthy();
    expect(test.available).toBe(true);
  });
});

describe("CORE-03 routes — conversations", () => {
  it("POST /api/ai/conversations creates a conversation", async () => {
    const res = await conversationsRoute.POST(
      req("/api/ai/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, title: "New chat" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.conversation.id).toBeTruthy();
    expect(body.conversation.workspaceId).toBe(workspaceId);
  });

  it("POST /api/ai/conversations rejects an invalid workspace", async () => {
    const res = await conversationsRoute.POST(
      req("/api/ai/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "nonexistent", title: "X" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("GET /api/ai/conversations lists workspace conversations", async () => {
    const res = await conversationsRoute.GET(req(`/api/ai/conversations?workspaceId=${workspaceId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.conversations)).toBe(true);
    expect(body.conversations.some((c: { id: string }) => c.id === conversationId)).toBe(true);
  });

  it("PATCH /api/ai/conversations/[id] renames and DELETE removes it", async () => {
    const patch = await conversationsIdRoute.PATCH(
      req(`/api/ai/conversations/${conversationId}?workspaceId=${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed", selectedModelId: "test.general" }),
      }),
      { params: { id: conversationId } },
    );
    expect(patch.status).toBe(200);
    const del = await conversationsIdRoute.DELETE(
      req(`/api/ai/conversations/${conversationId}?workspaceId=${workspaceId}`, { method: "DELETE" }),
      { params: { id: conversationId } },
    );
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expect(delBody.deleted).toBe(true);
  });

  it("GET /api/ai/conversations/[id]/messages returns messages", async () => {
    const res = await messagesRoute.GET(
      req(`/api/ai/conversations/${conversationId}/messages?workspaceId=${workspaceId}`),
      { params: { id: conversationId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe("CORE-03 routes — agents", () => {
  it("GET /api/ai/agents lists the registered system orchestrator", async () => {
    const res = await agentsRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    const sys = body.agents.find((a: { agentId: string }) => a.agentId === "bean.system.orchestrator");
    expect(sys).toBeTruthy();
    expect(sys.category).toBe("system");
  });
});

describe("CORE-03 routes — intent", () => {
  it("POST /api/ai/intent returns a validated intent", async () => {
    const res = await intentRoute.POST(
      req("/api/ai/intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, message: "List the commands" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intent).toBeTruthy();
    expect(body.intent.taskCategory).toBeTruthy();
    expect(body.intent.requiresClarification).toBe(false);
  });
});

describe("CORE-03 routes — plan", () => {
  it("POST /api/ai/plan returns a validated plan", async () => {
    const res = await planRoute.POST(
      req("/api/ai/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, conversationId, message: "List the commands" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBeTruthy();
    expect(body.plan.tasks.length).toBeGreaterThan(0);
  });
});

describe("CORE-03 routes — chat streaming", () => {
  it("POST /api/ai/chat streams NDJSON events and persists messages", async () => {
    const res = await chatRoute.POST(
      req("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          conversationId,
          message: "List the registered commands",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readNdjson(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("meta");
    expect(types).toContain("delta");
    expect(types).toContain("plan");
    expect(types).toContain("complete");

    // The assistant message is persisted.
    const msgs = await messagesRoute.GET(
      req(`/api/ai/conversations/${conversationId}/messages?workspaceId=${workspaceId}`),
      { params: { id: conversationId } },
    );
    const msgBody = await msgs.json();
    const roles = msgBody.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  it("POST /api/ai/chat returns 403 for a non-member workspace", async () => {
    // A workspace owned by a different user; the caller is NOT a member.
    const otherUser = services.identity.linkAuthAccount("local-test", `other:${uuid()}`, { displayName: "Other" }).user;
    const other = services.workspace.createWorkspace(otherUser.id, "PROFESSIONAL", "Other");
    const res = await chatRoute.POST(
      req("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: other.id,
          conversationId,
          message: "hello",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/ai/chat returns 400 for an invalid body", async () => {
    const res = await chatRoute.POST(
      req("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
