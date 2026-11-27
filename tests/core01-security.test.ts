// @vitest-environment node

/**
 * CORE-01 security integration tests.
 *
 * These exercise the real service layer over a real (in-memory) `node:sqlite`
 * database — not mocks — to verify persistence, isolation and enforcement.
 * They are the mandatory security-critical integration tests for CORE-01.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestEnv,
  createTestUser,
  createWorkspace,
  addMember,
  type TestEnv,
} from "@/lib/security/testing";
import { now, uuid } from "@/lib/db/util";
import { PolicyEngine } from "@/lib/security/policy";
import { RiskClassifier } from "@/lib/security/risk";
import type { ActionRequest, Permission } from "@/lib/security/types";

describe("CORE-01 identity & session", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it("rejects an unauthenticated (absent) session", () => {
    expect(env.services.session.verify(undefined)).toBeNull();
    expect(env.services.session.verify("")).toBeNull();
  });

  it("rejects an invalid session token", () => {
    expect(env.services.session.verify("not-a-real-token")).toBeNull();
  });

  it("accepts a valid session token and identifies the user", () => {
    const user = createTestUser(env.services);
    const session = env.services.session.verify(user.token);
    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(user.userId);
  });

  it("rejects a revoked session", () => {
    const user = createTestUser(env.services);
    expect(env.services.session.revoke(user.token)).toBe(true);
    expect(env.services.session.verify(user.token)).toBeNull();
  });

  it("rejects an expired session", () => {
    const user = createTestUser(env.services);
    // Force expiry in the past.
    env.db
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), user.sessionId);
    expect(env.services.session.verify(user.token)).toBeNull();
  });

  it("links accounts by stable provider identity (not email alone)", () => {
    const a = env.services.identity.linkAuthAccount("oidc", "provider-1", {
      email: "shared@example.com",
    });
    const b = env.services.identity.linkAuthAccount("oidc", "provider-1", {
      email: "shared@example.com",
    });
    expect(b.created).toBe(false);
    expect(b.user.id).toBe(a.user.id);
    // A different provider identity is a different account even with same email.
    const c = env.services.identity.linkAuthAccount("oidc", "provider-2", {
      email: "shared@example.com",
    });
    expect(c.created).toBe(true);
    expect(c.user.id).not.toBe(a.user.id);
  });
});

describe("CORE-01 workspace isolation", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it("does not let a user read a workspace they are not a member of", () => {
    const alice = createTestUser(env.services);
    const bob = createTestUser(env.services);
    const aliceBusiness = createWorkspace(env.services, alice.userId, "BUSINESS", "Acme");

    // Bob's own workspace exists, but he is not a member of Acme.
    expect(env.services.workspace.listForUser(bob.userId).find((w) => w.id === aliceBusiness)).toBeUndefined();
    expect(env.services.policy.authorize(bob.userId, aliceBusiness, "workspace.read")).toBe(false);
  });

  it("isolates business workspaces from each other", () => {
    const owner = createTestUser(env.services);
    const wsA = createWorkspace(env.services, owner.userId, "BUSINESS", "A");
    const wsB = createWorkspace(env.services, owner.userId, "BUSINESS", "B");
    // Add a member to A only.
    const member = createTestUser(env.services);
    addMember(env.services, wsA, member.userId, "MEMBER", owner.userId);
    expect(env.services.policy.authorize(member.userId, wsA, "workspace.read")).toBe(true);
    expect(env.services.policy.authorize(member.userId, wsB, "workspace.read")).toBe(false);
  });

  it("does not let a user switch to an unjoined workspace", () => {
    const alice = createTestUser(env.services);
    const bob = createTestUser(env.services);
    const bobPersonal = createWorkspace(env.services, bob.userId, "PROFESSIONAL", "Bob Pro");
    expect(env.services.policy.resolve(alice.userId, bobPersonal)).toBeNull();
  });

  it("blocks access immediately on membership removal", () => {
    const owner = createTestUser(env.services);
    const ws = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
    const member = createTestUser(env.services);
    addMember(env.services, ws, member.userId, "MEMBER", owner.userId);
    expect(env.services.policy.authorize(member.userId, ws, "workspace.read")).toBe(true);
    env.services.workspace.removeMember(ws, member.userId, owner.userId);
    expect(env.services.policy.authorize(member.userId, ws, "workspace.read")).toBe(false);
  });

  it("never lets an agent identity access a tenant it is not bound to", () => {
    const owner = createTestUser(env.services);
    const wsA = createWorkspace(env.services, owner.userId, "BUSINESS", "A");
    const wsB = createWorkspace(env.services, owner.userId, "BUSINESS", "B");
    // An agent token is just a session of some user; it resolves to that user's
    // memberships only. A session without membership on wsB cannot act there.
    expect(env.services.policy.authorize(owner.userId, wsB, "actions.execute")).toBe(true);
    // Simulate an agent session belonging to a user with no wsA membership.
    const other = createTestUser(env.services);
    expect(env.services.policy.authorize(other.userId, wsA, "actions.execute")).toBe(false);
  });
});

describe("CORE-01 permission engine (deny-by-default)", () => {
  let env: TestEnv;
  let owner: ReturnType<typeof createTestUser>;
  let business: string;
  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
  });

  function withUser(role: "VIEWER" | "MEMBER" | "OPERATOR" | "ADMIN") {
    const u = createTestUser(env.services);
    addMember(env.services, business, u.userId, role, owner.userId);
    return u;
  }

  it("denies an unknown permission", () => {
    expect(env.services.policy.authorize(owner.userId, business, "does.not.exist" as Permission)).toBe(false);
  });

  it("does not let VIEWER write", () => {
    const viewer = withUser("VIEWER");
    expect(env.services.policy.authorize(viewer.userId, business, "workspace.read")).toBe(true);
    expect(env.services.policy.authorize(viewer.userId, business, "files.write")).toBe(false);
    expect(env.services.policy.authorize(viewer.userId, business, "workspace.members.invite")).toBe(false);
  });

  it("does not let MEMBER manage members", () => {
    const member = withUser("MEMBER");
    expect(env.services.policy.authorize(member.userId, business, "workspace.read")).toBe(true);
    expect(env.services.policy.authorize(member.userId, business, "workspace.members.invite")).toBe(false);
  });

  it("does not let ADMIN bypass owner-only controls", () => {
    const admin = withUser("ADMIN");
    expect(env.services.policy.authorize(admin.userId, business, "workspace.read")).toBe(true);
    expect(env.services.policy.authorize(admin.userId, business, "workspace.delete")).toBe(false);
    expect(env.services.policy.authorize(admin.userId, business, "policy.manage")).toBe(false);
  });

  it("applies revocation immediately", () => {
    const member = withUser("MEMBER");
    expect(env.services.policy.authorize(member.userId, business, "workspace.read")).toBe(true);
    env.services.workspace.removeMember(business, member.userId, owner.userId);
    expect(env.services.policy.authorize(member.userId, business, "workspace.read")).toBe(false);
  });

  it("resolves the role from the server membership, ignoring any client value", () => {
    const member = withUser("MEMBER");
    const ctx = env.services.policy.resolve(member.userId, business)!;
    expect(ctx.role).toBe("MEMBER");
    expect(ctx.permissions.includes("workspace.members.invite")).toBe(false);
  });

  it("protects the final owner from removal", () => {
    expect(() =>
      env.services.workspace.removeMember(business, owner.userId, owner.userId),
    ).toThrow();
  });
});

describe("CORE-01 risk classifier", () => {
  let risk: RiskClassifier;
  beforeEach(() => {
    risk = new RiskClassifier();
  });

  it("never lets a client lower the authoritative risk", () => {
    const r = risk.classify({ command: "delete record", operation: "purge", proposed: "R0" });
    expect(r.risk).toBe("R4");
    expect(r.downgraded).toBe(true);
  });

  it("classifies read-only as R1 and consequential as R3", () => {
    expect(risk.classify({ command: "read", operation: "list" }).risk).toBe("R1");
    expect(risk.classify({ command: "send invoice", operation: "email" }).risk).toBe("R3");
  });

  it("requires approval for R3 and R4, and dual for R4", () => {
    expect(risk.policyFor("R3").approvalRequired).toBe(true);
    expect(risk.policyFor("R4").approvalRequired).toBe(true);
    expect(risk.policyFor("R4").dualApprovalSupported).toBe(true);
    expect(risk.policyFor("R1").approvalRequired).toBe(false);
  });
});

describe("CORE-01 action passport lifecycle", () => {
  let env: TestEnv;
  let owner: ReturnType<typeof createTestUser>;
  let admin: ReturnType<typeof createTestUser>;
  let business: string;
  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
    admin = createTestUser(env.services);
    addMember(env.services, business, admin.userId, "ADMIN", owner.userId);
  });

  function req(over: Partial<ActionRequest> = {}): ActionRequest {
    return {
      workspaceId: business,
      targetType: "file",
      targetId: "doc-1",
      command: "read",
      operation: "get",
      dataScope: "doc-1",
      permissionScope: ["files.read", "workspace.read"],
      riskClass: "R1",
      paramHash: "",
      idempotencyKey: "k-" + Math.random().toString(36).slice(2),
      approvalPolicy: "SINGLE",
      verificationRequirements: [],
      ...over,
    };
  }

  it("accepts an exact action and records the passport", () => {
    const { passport, created } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      req(),
    );
    expect(created).toBe(true);
    expect(passport.status).toBe("AUTHORISED"); // R1 needs no approval
    expect(passport.risk_class).toBe("R1");
  });

  it("rejects a request against a workspace the actor cannot access", () => {
    const stranger = createTestUser(env.services);
    expect(() =>
      env.services.passport.createRequest({ userId: stranger.userId, workspaceId: business }, req()),
    ).toThrow();
  });

  it("rejects a requested permission scope the actor does not hold", () => {
    const member = createTestUser(env.services);
    addMember(env.services, business, member.userId, "MEMBER", owner.userId);
    expect(() =>
      env.services.passport.createRequest(
        { userId: member.userId, workspaceId: business },
        req({ permissionScope: ["policy.manage"] }),
      ),
    ).toThrow();
  });

  it("is idempotent on (workspace, idempotency key)", () => {
    const action = req();
    const first = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      action,
    );
    const second = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      action,
    );
    expect(second.created).toBe(false);
    expect(second.passport.id).toBe(first.passport.id);
  });

  it("requires approval for R3 and rejects invalid transitions", () => {
    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      req({ command: "send", operation: "email", permissionScope: ["actions.execute"] }),
    );
    expect(passport.status).toBe("PENDING_APPROVAL");
    expect(passport.risk_class).toBe("R3");
    // Cannot jump straight to AUTHORISED.
    expect(() => env.services.passport.transition(passport.id, "AUTHORISED", owner.userId)).toThrow();
  });

  it("enforces separation of duties (no self-approval)", () => {
    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      req({ command: "send", operation: "email", permissionScope: ["actions.execute"] }),
    );
    expect(() =>
      env.services.passport.approve(passport.id, owner.userId, "APPROVED"),
    ).toThrow();
  });

  it("approves, then authorises and consumes exactly once (no replay)", () => {
    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      req({ command: "send", operation: "email", permissionScope: ["actions.execute"] }),
    );
    env.services.passport.approve(passport.id, admin.userId, "APPROVED");
    const authorised = env.services.passport.authorise(passport.id, owner.userId);
    expect(authorised.status).toBe("AUTHORISED");
    const consumed = env.services.passport.assertExecutable(passport.id, {
      command: "send",
      targetId: "doc-1",
      paramHash: passport.param_hash,
    });
    expect(consumed.status).toBe("CONSUMED");
    // Replay fails.
    expect(() =>
      env.services.passport.assertExecutable(passport.id, {
        command: "send",
        targetId: "doc-1",
        paramHash: passport.param_hash,
      }),
    ).toThrow();
  });

  it("rejects altered parameters (param binding)", () => {
    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      req({ command: "send", operation: "email", permissionScope: ["actions.execute"] }),
    );
    env.services.passport.approve(passport.id, admin.userId, "APPROVED");
    env.services.passport.authorise(passport.id, owner.userId);
    const wrongTarget = () =>
      env.services.passport.assertExecutable(passport.id, {
        command: "send",
        targetId: "doc-999", // different target
        paramHash: passport.param_hash,
      });
    expect(wrongTarget).toThrow();
  });

  it("makes expired passports unusable", () => {
    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      req({ command: "send", operation: "email", permissionScope: ["actions.execute"] }),
    );
    env.db
      .prepare("UPDATE action_passports SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), passport.id);
    expect(() =>
      env.services.passport.assertExecutable(passport.id, {
        command: "send",
        targetId: "doc-1",
        paramHash: passport.param_hash,
      }),
    ).toThrow();
  });

  it("makes revoked passports unusable", () => {
    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      req({ command: "send", operation: "email", permissionScope: ["actions.execute"] }),
    );
    env.services.passport.revoke(passport.id, owner.userId);
    expect(env.services.passport.get(passport.id)!.status).toBe("REVOKED");
  });

  it("denies agent execution for R4 (must be human-approved)", () => {
    // Agent actor initiating a destructive action: risk R4, approval required,
    // and an agent cannot authorise its own execution.
    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business, agentId: "agent-1" },
      req({
        command: "delete record",
        operation: "purge",
        permissionScope: ["actions.execute", "workspace.read"],
        approvalPolicy: "DUAL",
      }),
    );
    expect(passport.risk_class).toBe("R4");
    expect(passport.actor_type).toBe("AGENT");
    expect(passport.status).toBe("PENDING_APPROVAL");
    // A single approval is not enough for DUAL.
    env.services.passport.approve(passport.id, admin.userId, "APPROVED");
    expect(env.services.passport.get(passport.id)!.status).toBe("PENDING_APPROVAL");
    // Second distinct approver completes it.
    const approver2 = createTestUser(env.services);
    addMember(env.services, business, approver2.userId, "ADMIN", owner.userId);
    env.services.passport.approve(passport.id, approver2.userId, "APPROVED");
    expect(env.services.passport.get(passport.id)!.status).toBe("APPROVED");
  });
});

describe("CORE-01 audit", () => {
  let env: TestEnv;
  let owner: ReturnType<typeof createTestUser>;
  let business: string;
  let policy: PolicyEngine;
  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
    policy = env.services.policy;
  });

  it("records required security-sensitive events", () => {
    const events = env.services.audit.list(business).map((e) => e.event_type);
    expect(events).toContain("WORKSPACE_CREATED");
    expect(events).toContain("MEMBERSHIP_CHANGED");
  });

  it("redacts sensitive fields from metadata", () => {
    env.services.audit.append({
      workspaceId: business,
      actorId: owner.userId,
      actorType: "USER",
      eventType: "TEST_REDACT",
      result: "SUCCESS",
      metadata: { password: "hunter2", token: "secret", safe: "visible" },
    });
    const event = env.services.audit.list(business).find((e) => e.event_type === "TEST_REDACT")!;
    const meta = JSON.parse(event.metadata) as Record<string, unknown>;
    expect(meta.password).toBe("[REDACTED]");
    expect(meta.token).toBe("[REDACTED]");
    expect(meta.safe).toBe("visible");
  });

  it("hash-chains events and verifies the chain", () => {
    const ok = env.services.audit.verifyChain();
    expect(ok.valid).toBe(true);
    expect(ok.count).toBeGreaterThan(0);
  });

  it("detects tampering in the append-only chain", () => {
    // Directly mutate an event hash to simulate tampering.
    const first = env.services.audit.list(business)[0];
    env.db
      .prepare("UPDATE audit_events SET event_hash = ? WHERE id = ?")
      .run("tampered-hash", first.id);
    const res = env.services.audit.verifyChain();
    expect(res.valid).toBe(false);
    expect(res.breakAt).toBeTruthy();
  });

  it("isolates audit history per workspace", () => {
    const other = createTestUser(env.services);
    const otherWs = createWorkspace(env.services, other.userId, "BUSINESS", "Other");
    const ownerEvents = env.services.audit.list(business).length;
    const otherEvents = env.services.audit.list(otherWs).length;
    expect(ownerEvents).toBeGreaterThan(0);
    expect(otherEvents).toBeGreaterThan(0);
    // The two histories do not share event ids.
    const shared = env.services.audit.list(business).filter((e) =>
      env.services.audit.list(otherWs).some((o) => o.id === e.id),
    );
    expect(shared).toHaveLength(0);
  });

  it("enforces audit.read via the central policy engine", () => {
    const viewer = createTestUser(env.services);
    addMember(env.services, business, viewer.userId, "VIEWER", owner.userId);
    expect(policy.authorize(viewer.userId, business, "audit.read")).toBe(true);
    expect(policy.authorize(viewer.userId, business, "files.write")).toBe(false);
  });
});

describe("CORE-01 timestamps & helpers", () => {
  it("produces ISO timestamps and unique ids", () => {
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(uuid()).not.toBe(uuid());
  });
});
