// @vitest-environment node

/**
 * CORE-02 — universal command registry, capability fabric, command gateway,
 * full-payload passport binding, execution lifecycle and cross-workspace tests.
 *
 * Real database integration tests over node:sqlite. No security-critical
 * assertion relies on mocked policy results.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  createTestEnv,
  createTestUser,
  createWorkspace,
  addMember,
  type TestEnv,
} from "@/lib/security/testing";
import {
  computeParamHash,
  computeBindingHash,
  canonicalize,
  CanonicalisationError,
} from "@/lib/commands/canonical";
import { CommandRegistry, RegistryError } from "@/lib/commands/registry";
import { CapabilityRegistry, CapabilityError } from "@/lib/commands/capability";
import { ExecutionLifecycleManager, LifecycleError } from "@/lib/commands/lifecycle";
import { TestCommandAdapter } from "@/lib/commands/adapter";
import { BUILTIN_COMMANDS } from "@/lib/commands/builtin";
import type { CommandDefinition } from "@/lib/commands/types";
import type { Permission } from "@/lib/security/types";

describe("CORE-02 canonicalisation & full-payload binding (security regression)", () => {
  it("produces deterministic output regardless of key insertion order", () => {
    const a = canonicalize({ b: 2, a: 1, c: { z: 1, y: 2 } });
    const b = canonicalize({ c: { y: 2, z: 1 }, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("preserves meaningful array ordering", () => {
    const a = canonicalize({ list: [1, 2, 3] });
    const b = canonicalize({ list: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it("rejects undefined, non-finite numbers and unsupported types", () => {
    expect(() => canonicalize({ x: undefined })).toThrow(CanonicalisationError);
    expect(() => canonicalize({ x: NaN })).toThrow(CanonicalisationError);
    expect(() => canonicalize({ x: Infinity })).toThrow(CanonicalisationError);
    expect(() => canonicalize({ x: () => 1 })).toThrow(CanonicalisationError);
  });

  it("redacts sensitive keys so secrets never enter a hash", () => {
    const h1 = computeBindingHash({
      workspaceId: "w", commandId: "c", commandVersion: "1", targetType: "t", targetId: "1",
      args: { apiKey: "secret-value", safe: "ok" },
    });
    const h2 = computeBindingHash({
      workspaceId: "w", commandId: "c", commandVersion: "1", targetType: "t", targetId: "1",
      args: { apiKey: "different-secret", safe: "ok" },
    });
    // Sensitive keys are masked, so the hash is identical regardless of the secret value.
    expect(h1).toBe(h2);
  });

  // REGRESSION TEST for the CORE-01 computeParamHash security gap.
  it("REGRESSION: param hash covers the complete argument payload", () => {
    const base = {
      workspaceId: "w1",
      command: "invoice.send",
      targetType: "invoice",
      targetId: "inv-1",
      dataScope: "w1",
    };
    const hApproved = computeParamHash({ ...base, params: { amount: 1000, recipient: "A" } });
    const hMutated = computeParamHash({ ...base, params: { amount: 10000, recipient: "B" } });
    // Before the fix these were identical; now they must differ.
    expect(hApproved).not.toBe(hMutated);
  });

  it("REGRESSION: different target or workspace yields a different binding hash", () => {
    const a = computeBindingHash({ workspaceId: "w1", commandId: "c", commandVersion: "1", targetType: "t", targetId: "1", args: {} });
    const b = computeBindingHash({ workspaceId: "w2", commandId: "c", commandVersion: "1", targetType: "t", targetId: "1", args: {} });
    const c = computeBindingHash({ workspaceId: "w1", commandId: "c", commandVersion: "2", targetType: "t", targetId: "1", args: {} });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("CORE-02 command registry", () => {
  let env: TestEnv;
  let registry: CommandRegistry;
  beforeEach(() => {
    env = createTestEnv();
    registry = env.services.commands;
  });

  it("seeds the built-in command catalogue", () => {
    expect(registry.list().length).toBe(BUILTIN_COMMANDS.length);
    expect(registry.get("platform.commands.list")?.commandId).toBe("platform.commands.list");
  });

  it("resolves the latest supported version", () => {
    const def = registry.get("workspace.members.list");
    expect(def?.version).toBe("1.0.0");
  });

  it("rejects duplicate command versions", () => {
    const dup = BUILTIN_COMMANDS[0];
    expect(() => registry.register(dup, "actor")).toThrow(RegistryError);
  });

  it("registers a new valid command version", () => {
    const def: CommandDefinition = {
      commandId: "test.echo",
      version: "1.0.0",
      name: "Echo",
      description: "test",
      category: "platform",
      inputSchema: z.object({ msg: z.string() }),
      requiredCapability: null,
      requiredPermissions: ["workspace.read"],
      serverRiskClass: "R1",
      approvalPolicy: "NONE",
      targetRequirements: { required: false },
      executionMode: "SYNC",
      timeoutPolicy: { maxSeconds: 5, cancellable: true },
      rateLimitPolicy: { maxRequests: 10, windowSeconds: 60 },
      idempotencyPolicy: { enforced: false, scope: "workspace" },
      verificationContract: { type: "result_validation", description: "d", independentCheck: false },
      compensationContract: { supported: false, description: "d" },
      availabilityRequirements: [],
      deprecationStatus: "ACTIVE",
      documentation: "d",
    };
    registry.register(def, "actor");
    expect(registry.get("test.echo")?.version).toBe("1.0.0");
  });

  it("rejects unknown commands", () => {
    expect(() => registry.assertSupported("does.not.exist")).toThrow(RegistryError);
  });

  it("deprecates a version and keeps it resolvable until retired", () => {
    registry.deprecate("platform.commands.list", "1.0.0", "actor");
    expect(registry.get("platform.commands.list")?.deprecationStatus).toBe("DEPRECATED");
  });
});

describe("CORE-02 capability registry", () => {
  let env: TestEnv;
  let caps: CapabilityRegistry;
  beforeEach(() => {
    env = createTestEnv();
    caps = env.services.capabilities;
  });

  it("seeds built-in capabilities", () => {
    expect(caps.list().length).toBeGreaterThan(0);
    expect(caps.get("platform.registry")?.availabilityStatus).toBe("AVAILABLE");
  });

  it("distinguishes registered from available", () => {
    expect(caps.get("browser.automation")?.availabilityStatus).toBe("PLANNED");
    expect(caps.isUsable("browser.automation")).toBe(false);
    expect(caps.isUsable("platform.registry")).toBe(true);
  });

  it("rejects duplicate capability registration", () => {
    expect(() => caps.register(caps.get("email")!, "actor")).toThrow(CapabilityError);
  });

  it("handles disabled and revoked capabilities as unusable", () => {
    caps.setStatus("email", "DISABLED", "actor");
    expect(caps.isUsable("email")).toBe(false);
    caps.setStatus("email", "REVOKED", "actor");
    expect(caps.isUsable("email")).toBe(false);
  });

  it("prevent capability permission escalation", () => {
    const cap = caps.get("file.storage")!;
    // actor without files.read cannot use a capability requiring it.
    expect(() => caps.assertNoEscalation(cap, ["workspace.read"])).toThrow(CapabilityError);
    expect(() => caps.assertNoEscalation(cap, ["workspace.read", "files.read"])).not.toThrow();
  });
});

describe("CORE-02 command gateway — security & routing", () => {
  let env: TestEnv;
  let owner: ReturnType<typeof createTestUser>;
  let business: string;
  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
  });

  it("accepts a valid internal command and verifies it", async () => {
    const outcome = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "k1" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("VERIFIED");
    expect(outcome.commandId).toBe("platform.commands.list");
  });

  it("rejects a missing session / non-member workspace", async () => {
    const stranger = createTestUser(env.services);
    const outcome = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "k2" },
      { userId: stranger.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.errorCode).toBe("WORKSPACE_DENIED");
  });

  it("rejects unknown commands", async () => {
    const outcome = await env.services.gateway.submit(
      { commandId: "nope.nothing", workspaceId: business, args: {}, idempotencyKey: "k3" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.errorCode).toBe("UNKNOWN_COMMAND");
  });

  it("rejects invalid payloads", async () => {
    const outcome = await env.services.gateway.submit(
      { commandId: "platform.commands.describe", workspaceId: business, args: {}, idempotencyKey: "k4" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.errorCode).toBe("INVALID_ARGS");
  });

  it("denies insufficient permissions (VIEWER cannot list members)", async () => {
    const viewer = createTestUser(env.services);
    addMember(env.services, business, viewer.userId, "VIEWER", owner.userId);
    const outcome = await env.services.gateway.submit(
      { commandId: "workspace.members.list", workspaceId: business, args: {}, idempotencyKey: "k5" },
      { userId: viewer.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.errorCode).toBe("PERMISSION_DENIED");
  });

  it("never lets the client lower risk (server-authoritative)", async () => {
    // A command declared R3 cannot be submitted as R0; risk is from the registry.
    const def = env.services.commands.get("platform.commands.list")!;
    expect(def.serverRiskClass).toBe("R1");
    // Submitting extra args cannot change the resolved risk.
    const outcome = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "k6", executionOptions: { riskClass: "R0" } },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.riskClass).toBe("R1");
  });

  it("rejects unavailable capabilities", async () => {
    // Register a command requiring a PLANNED capability.
    const cap = env.services.capabilities.get("browser.automation")!;
    const def: CommandDefinition = {
      commandId: "browser.open",
      version: "1.0.0",
      name: "Open browser",
      description: "test",
      category: "integration",
      inputSchema: z.object({ url: z.string() }),
      requiredCapability: cap.capabilityId,
      requiredPermissions: ["workspace.read"],
      serverRiskClass: "R2",
      approvalPolicy: "NONE",
      targetRequirements: { required: false },
      executionMode: "SYNC",
      timeoutPolicy: { maxSeconds: 5, cancellable: true },
      rateLimitPolicy: { maxRequests: 10, windowSeconds: 60 },
      idempotencyPolicy: { enforced: false, scope: "workspace" },
      verificationContract: { type: "result_validation", description: "d", independentCheck: false },
      compensationContract: { supported: false, description: "d" },
      availabilityRequirements: [],
      deprecationStatus: "ACTIVE",
      documentation: "d",
    };
    env.services.commands.register(def, owner.userId);
    const outcome = await env.services.gateway.submit(
      { commandId: "browser.open", workspaceId: business, args: { url: "https://x" }, idempotencyKey: "k7" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.errorCode).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("routes an authorised capability command through a test adapter and verifies", async () => {
    const cap = env.services.capabilities.get("browser.automation")!;
    env.services.capabilities.setStatus("browser.automation", "AVAILABLE", owner.userId);
    const def: CommandDefinition = {
      commandId: "browser.open",
      version: "1.0.0",
      name: "Open browser",
      description: "test",
      category: "integration",
      inputSchema: z.object({ url: z.string() }),
      requiredCapability: cap.capabilityId,
      requiredPermissions: ["workspace.read"],
      serverRiskClass: "R2",
      approvalPolicy: "NONE",
      targetRequirements: { required: false },
      executionMode: "SYNC",
      timeoutPolicy: { maxSeconds: 5, cancellable: true },
      rateLimitPolicy: { maxRequests: 10, windowSeconds: 60 },
      idempotencyPolicy: { enforced: false, scope: "workspace" },
      verificationContract: { type: "read_after_write", description: "d", independentCheck: true },
      compensationContract: { supported: true, description: "d" },
      availabilityRequirements: [],
      deprecationStatus: "ACTIVE",
      documentation: "d",
    };
    env.services.commands.register(def, owner.userId);
    const adapter = new TestCommandAdapter({ adapterId: "test-browser", supportedCommands: ["browser.open"], requiredPermissions: ["workspace.read"] });
    adapter.executeResult = { success: true, output: { opened: true }, evidence: { checked: true } };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await env.services.gateway.submit(
      { commandId: "browser.open", workspaceId: business, args: { url: "https://x" }, idempotencyKey: "k8" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("VERIFIED");
    expect(adapter.calls).toContain("execute");
    expect(adapter.calls).toContain("prepare");
  });

  it("is idempotent on (workspace, idempotency key)", async () => {
    const req = { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "idem-1" };
    const first = await env.services.gateway.submit(req, { userId: owner.userId, workspaceId: business });
    const second = await env.services.gateway.submit(req, { userId: owner.userId, workspaceId: business });
    expect(second.executionId).toBe(first.executionId);
  });

  it("preview validates without executing or creating a passport", () => {
    const plan = env.services.gateway.preview(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "p1" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(plan.errors).toHaveLength(0);
    expect(plan.permissionsOk).toBe(true);
    expect(plan.riskClass).toBe("R1");
  });
});

describe("CORE-02 passport full-payload binding (gateway level)", () => {
  let env: TestEnv;
  let owner: ReturnType<typeof createTestUser>;
  let business: string;
  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
  });

  it("binds the passport to the exact validated arguments", async () => {
    const outcome = await env.services.gateway.submit(
      { commandId: "platform.command.preview", workspaceId: business, args: { commandId: "platform.commands.list", args: {}, idempotencyKey: "pv-1" }, idempotencyKey: "exec-1" },
      { userId: owner.userId, workspaceId: business },
    );
    const passport = env.services.passport.get(outcome.passportId!)!;
    expect(passport.params_canonical).toContain("platform.command.preview");
    expect(passport.param_hash).toBe(outcome.paramsHash);
  });

  it("different arguments produce different passport binding hashes", async () => {
    const o1 = await env.services.gateway.submit(
      { commandId: "platform.command.preview", workspaceId: business, args: { commandId: "platform.commands.list", args: { x: 1 }, idempotencyKey: "pv-a" }, idempotencyKey: "exec-a" },
      { userId: owner.userId, workspaceId: business },
    );
    const o2 = await env.services.gateway.submit(
      { commandId: "platform.command.preview", workspaceId: business, args: { commandId: "platform.commands.list", args: { x: 2 }, idempotencyKey: "pv-b" }, idempotencyKey: "exec-b" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(o1.paramsHash).not.toBe(o2.paramsHash);
  });

  it("a passport bound to args A cannot be consumed with args B (tampering denied)", async () => {
    // Create a passport directly with params A, then attempt execution with params B's hash.
    const passport = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      {
        workspaceId: business,
        targetType: "invoice",
        targetId: "inv-1",
        command: "invoice.send",
        operation: "send",
        dataScope: business,
        permissionScope: ["actions.execute", "workspace.read"],
        riskClass: "R3",
        paramHash: computeParamHash({ workspaceId: business, command: "invoice.send", targetType: "invoice", targetId: "inv-1", dataScope: business, params: { amount: 1000, recipient: "A" } }),
        params: { amount: 1000, recipient: "A" },
        idempotencyKey: "bind-1",
        approvalPolicy: "SINGLE",
        verificationRequirements: [],
      },
    ).passport;
    // Approve + authorise.
    const admin = createTestUser(env.services);
    addMember(env.services, business, admin.userId, "ADMIN", owner.userId);
    env.services.passport.approve(passport.id, admin.userId, "APPROVED");
    env.services.passport.authorise(passport.id, owner.userId);

    // Attempt to consume with the mutated payload's hash — must fail.
    const mutatedHash = computeParamHash({ workspaceId: business, command: "invoice.send", targetType: "invoice", targetId: "inv-1", dataScope: business, params: { amount: 10000, recipient: "B" } });
    expect(() =>
      env.services.passport.assertExecutable(passport.id, { command: "invoice.send", targetId: "inv-1", paramHash: mutatedHash }),
    ).toThrow();
  });
});

describe("CORE-02 execution lifecycle", () => {
  let env: TestEnv;
  let owner: ReturnType<typeof createTestUser>;
  let business: string;
  let lifecycle: ExecutionLifecycleManager;
  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
    lifecycle = env.services.lifecycle;
  });

  it("enforces valid state transitions", () => {
    const rec = lifecycle.create({
      workspaceId: business, actorId: owner.userId, commandId: "c", commandVersion: "1",
      paramsHash: "h", idempotencyKey: "l1",
    });
    lifecycle.transition(rec.id, "VALIDATING");
    lifecycle.transition(rec.id, "VALIDATED");
    expect(lifecycle.get(rec.id)!.status).toBe("VALIDATED");
  });

  it("rejects invalid transitions", () => {
    const rec = lifecycle.create({
      workspaceId: business, actorId: owner.userId, commandId: "c", commandVersion: "1",
      paramsHash: "h", idempotencyKey: "l2",
    });
    expect(() => lifecycle.transition(rec.id, "VERIFIED")).toThrow(LifecycleError);
  });

  it("handles adapter failure and partial results", async () => {
    const cap = env.services.capabilities.get("browser.automation")!;
    env.services.capabilities.setStatus("browser.automation", "AVAILABLE", owner.userId);
    const def: CommandDefinition = {
      commandId: "browser.open", version: "1.0.0", name: "Open", description: "d", category: "integration",
      inputSchema: z.object({ url: z.string() }), requiredCapability: cap.capabilityId,
      requiredPermissions: ["workspace.read"], serverRiskClass: "R2", approvalPolicy: "NONE",
      targetRequirements: { required: false }, executionMode: "SYNC",
      timeoutPolicy: { maxSeconds: 5, cancellable: true }, rateLimitPolicy: { maxRequests: 10, windowSeconds: 60 },
      idempotencyPolicy: { enforced: false, scope: "workspace" },
      verificationContract: { type: "result_validation", description: "d", independentCheck: false },
      compensationContract: { supported: false, description: "d" }, availabilityRequirements: [],
      deprecationStatus: "ACTIVE", documentation: "d",
    };
    env.services.commands.register(def, owner.userId);
    const adapter = new TestCommandAdapter({ adapterId: "fail-adapter", supportedCommands: ["browser.open"] });
    adapter.executeResult = { success: false, errorCode: "TIMEOUT", retryable: false };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await env.services.gateway.submit(
      { commandId: "browser.open", workspaceId: business, args: { url: "x" }, idempotencyKey: "lf1" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorCode).toBe("TIMEOUT");
  });

  it("never labels a command VERIFIED without verification evidence", async () => {
    // An adapter that succeeds but provides no evidence -> PARTIAL, not VERIFIED.
    const cap = env.services.capabilities.get("browser.automation")!;
    env.services.capabilities.setStatus("browser.automation", "AVAILABLE", owner.userId);
    const def: CommandDefinition = {
      commandId: "browser.open", version: "1.0.0", name: "Open", description: "d", category: "integration",
      inputSchema: z.object({ url: z.string() }), requiredCapability: cap.capabilityId,
      requiredPermissions: ["workspace.read"], serverRiskClass: "R2", approvalPolicy: "NONE",
      targetRequirements: { required: false }, executionMode: "SYNC",
      timeoutPolicy: { maxSeconds: 5, cancellable: true }, rateLimitPolicy: { maxRequests: 10, windowSeconds: 60 },
      idempotencyPolicy: { enforced: false, scope: "workspace" },
      verificationContract: { type: "read_after_write", description: "d", independentCheck: true },
      compensationContract: { supported: false, description: "d" }, availabilityRequirements: [],
      deprecationStatus: "ACTIVE", documentation: "d",
    };
    env.services.commands.register(def, owner.userId);
    const adapter = new TestCommandAdapter({ adapterId: "no-evidence", supportedCommands: ["browser.open"] });
    adapter.executeResult = { success: true, output: { ok: true } }; // no evidence
    env.services.gateway.registerAdapter(adapter);

    const outcome = await env.services.gateway.submit(
      { commandId: "browser.open", workspaceId: business, args: { url: "x" }, idempotencyKey: "lv1" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("PARTIAL");
  });
});

describe("CORE-02 cross-workspace isolation", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it("user cannot submit requests for an inaccessible workspace", async () => {
    const alice = createTestUser(env.services);
    const bob = createTestUser(env.services);
    const aliceWs = createWorkspace(env.services, alice.userId, "BUSINESS", "Alice");
    const outcome = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: aliceWs, args: {}, idempotencyKey: "x1" },
      { userId: bob.userId, workspaceId: aliceWs },
    );
    expect(outcome.status).toBe("BLOCKED");
  });

  it("one tenant cannot discover another tenant's private connection metadata", () => {
    const alice = createTestUser(env.services);
    const bob = createTestUser(env.services);
    const aliceWs = createWorkspace(env.services, alice.userId, "BUSINESS", "Alice");
    // Capability registry is global metadata, but a user can only act within
    // workspaces they belong to; the gateway enforces workspace membership first.
    const plan = env.services.gateway.preview(
      { commandId: "platform.capabilities.list", workspaceId: aliceWs, args: {}, idempotencyKey: "x2" },
      { userId: bob.userId, workspaceId: aliceWs },
    );
    expect(plan.permissionsOk).toBe(false);
    expect(plan.errors.length).toBeGreaterThan(0);
  });

  it("delegated agents cannot gain broader access than the initiating principal", async () => {
    const owner = createTestUser(env.services);
    const business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
    const member = createTestUser(env.services);
    addMember(env.services, business, member.userId, "MEMBER", owner.userId);
    // A member-initiated agent action is bound to the member's permissions.
    const outcome = await env.services.gateway.submit(
      { commandId: "workspace.members.list", workspaceId: business, args: {}, idempotencyKey: "x3", agentId: "agent-1" },
      { userId: member.userId, workspaceId: business },
    );
    // MEMBER lacks workspace.members.read -> blocked.
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.errorCode).toBe("PERMISSION_DENIED");
  });
});
