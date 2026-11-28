// @vitest-environment node

/**
 * CORE-04A — Command adapter verification & lifecycle hardening.
 *
 * Verifies that the gateway uses the adapter's authoritative `verify()`
 * decision (not `Boolean(result.evidence)`), enforces the declared verification
 * capability, bounds prepare/execute/verify with the effective timeout
 * `min(command.timeoutPolicy.maxSeconds, adapter.timeoutSeconds)`, and records
 * uncertain outcomes honestly. Deterministic test adapters only — no live
 * external services or provider credentials.
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
import { TestCommandAdapter, type AdapterResult, type AdapterVerification, type CommandAdapter } from "@/lib/commands/adapter";
import type { CommandDefinition, VerificationContract } from "@/lib/commands/types";
import type { TestUser } from "@/lib/security/testing";

/** A deterministic adapter with configurable phase behaviour and abort observation. */
class ControlledAdapter implements CommandAdapter {
  readonly adapterId = "controlled";
  readonly version = "1.0.0";
  readonly supportedCommands: string[];
  readonly supportedWorkspaceTypes = ["PERSONAL", "PROFESSIONAL", "BUSINESS"];
  readonly requiredPermissions: string[];
  readonly riskRestrictions: string[] = [];
  readonly timeoutSeconds: number;
  readonly idempotent = true;
  readonly supportsVerification: boolean;
  readonly supportsCompensation = false;

  calls: string[] = [];
  sawAbort = false;
  prepareMode: "resolve" | "hang" | "throw" = "resolve";
  executeMode: "resolve" | "hang" | "throw" = "resolve";
  verifyMode: "resolve" | "hang" | "throw" = "resolve";
  executeResult: AdapterResult = { success: true, output: { ok: true } };
  verifyResult: AdapterVerification = { verified: true, evidence: { checked: true } };

  constructor(opts: {
    supportedCommands: string[];
    timeoutSeconds?: number;
    supportsVerification?: boolean;
    requiredPermissions?: string[];
  }) {
    this.supportedCommands = opts.supportedCommands;
    this.timeoutSeconds = opts.timeoutSeconds ?? 10;
    this.supportsVerification = opts.supportsVerification ?? true;
    this.requiredPermissions = opts.requiredPermissions ?? [];
  }

  describe() {
    return { adapterId: this.adapterId, version: this.version, testOnly: true };
  }
  validate() {
    /* accepts what the gateway already validated */
  }
  async prepare(ctx: { signal?: AbortSignal }) {
    this.calls.push("prepare");
    this.observe(ctx.signal);
    if (this.prepareMode === "hang") return hang(ctx.signal, () => (this.sawAbort = true));
    if (this.prepareMode === "throw") throw new Error("prepare boom");
  }
  async execute(ctx: { signal?: AbortSignal }) {
    this.calls.push("execute");
    this.observe(ctx.signal);
    if (this.executeMode === "hang") return hang(ctx.signal, () => (this.sawAbort = true));
    if (this.executeMode === "throw") throw new Error("execute boom");
    return this.executeResult;
  }
  async verify(ctx: { signal?: AbortSignal }, _result: AdapterResult) {
    this.calls.push("verify");
    this.observe(ctx.signal);
    if (this.verifyMode === "hang") return hang(ctx.signal, () => (this.sawAbort = true));
    if (this.verifyMode === "throw") throw new Error("verify boom");
    return this.verifyResult;
  }
  async compensate() {
    return { success: true, output: { compensated: true } };
  }
  async healthCheck() {
    return { healthy: true };
  }
  private observe(signal?: AbortSignal) {
    if (!signal) return;
    if (signal.aborted) {
      this.sawAbort = true;
      return;
    }
    signal.addEventListener("abort", () => {
      this.sawAbort = true;
    }, { once: true });
  }
}

/** A promise that never settles until the signal aborts (then rejects). */
function hang(signal: AbortSignal | undefined, onAbort: () => void): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbortHandler = () => {
      onAbort();
      reject(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbortHandler();
        return;
      }
      signal.addEventListener("abort", onAbortHandler, { once: true });
    }
  });
}

function baseCommand(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    commandId: "browser.open",
    version: "1.0.0",
    name: "Open browser",
    description: "test",
    category: "integration",
    inputSchema: z.object({ url: z.string() }),
    requiredCapability: "browser.automation",
    requiredPermissions: ["workspace.read"],
    serverRiskClass: "R2",
    approvalPolicy: "NONE",
    targetRequirements: { required: false },
    executionMode: "SYNC",
    timeoutPolicy: { maxSeconds: 5, cancellable: true },
    rateLimitPolicy: { maxRequests: 10, windowSeconds: 60 },
    idempotencyPolicy: { enforced: false, scope: "workspace" },
    verificationContract: { type: "read_after_write", description: "d", independentCheck: true },
    compensationContract: { supported: false, description: "d" },
    availabilityRequirements: [],
    deprecationStatus: "ACTIVE",
    documentation: "d",
    ...overrides,
  };
}

describe("CORE-04A adapter verification & lifecycle hardening", () => {
  let env: TestEnv;
  let owner: TestUser;
  let business: string;

  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
    // Make the browser capability usable for adapter-backed commands.
    env.services.capabilities.setStatus("browser.automation", "AVAILABLE", owner.userId);
  });

  function setupAdapterCommand(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
    const def = baseCommand(overrides);
    env.services.commands.register(def, owner.userId);
    return def;
  }

  function submit(def: CommandDefinition, args: Record<string, unknown>, key: string, actor = owner) {
    return env.services.gateway.submit(
      { commandId: def.commandId, workspaceId: business, args, idempotencyKey: key },
      { userId: actor.userId, workspaceId: business },
    );
  }

  // ---------------------------------------------------------------- A. authoritative verification

  it("execute succeeds and verify() confirms with valid evidence -> VERIFIED", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    adapter.executeResult = { success: true, output: { opened: true } };
    adapter.verifyResult = { verified: true, evidence: { receiptId: "r-1" } };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "v-ok");
    expect(outcome.status).toBe("VERIFIED");
    expect(adapter.calls).toContain("execute");
    expect(adapter.calls).toContain("verify");
    // Execution output and verification evidence are stored distinctly.
    const rec = env.services.lifecycle.get(outcome.executionId)!;
    expect(JSON.parse(rec.result as string)).toEqual({ opened: true });
    expect(JSON.parse(rec.evidence as string)).toEqual({ receiptId: "r-1" });
  });

  it("execute succeeds with evidence but verify() returns false -> PARTIAL", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    adapter.executeResult = { success: true, output: { opened: true }, evidence: { checked: true } };
    adapter.verifyResult = { verified: false, evidence: { checked: true }, reason: "state not confirmed" };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "v-false");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("VERIFICATION_FAILED");
    expect(outcome.message).toContain("state not confirmed");
  });

  it("execute succeeds but verify() throws -> never VERIFIED", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    adapter.verifyMode = "throw";
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "v-throw");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.status).not.toBe("VERIFIED");
    expect(outcome.errorCode).toBe("VERIFICATION_ERROR");
  });

  it("verify() returns empty evidence -> never VERIFIED", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    adapter.verifyResult = { verified: true, evidence: {} };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "v-empty");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("VERIFICATION_EVIDENCE_INVALID");
  });

  it("verify() returns non-serialisable evidence -> never VERIFIED", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    adapter.verifyResult = { verified: true, evidence: { bad: () => 1 } as unknown as Record<string, unknown> };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "v-bad");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("VERIFICATION_EVIDENCE_INVALID");
  });

  it("verification decision wins over execution evidence", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    adapter.executeResult = { success: true, output: { ok: true }, evidence: { looksVerified: true } };
    adapter.verifyResult = { verified: false, evidence: { looksVerified: true }, reason: "mismatch" };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "v-mismatch");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("VERIFICATION_FAILED");
  });

  it("manual-verification contract is never auto-verified", async () => {
    setupAdapterCommand({
      verificationContract: { type: "manual", description: "human check", independentCheck: false },
    });
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand({ verificationContract: { type: "manual", description: "human check", independentCheck: false } }), { url: "https://x" }, "v-manual");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("VERIFICATION_MANUAL_REQUIRED");
    expect(adapter.calls).not.toContain("verify");
  });

  // ---------------------------------------------------------------- B. verification capability

  it("adapter cannot provide required verification -> fail closed before execution", async () => {
    setupAdapterCommand({
      verificationContract: { type: "read_after_write", description: "d", independentCheck: true },
    });
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"], supportsVerification: false });
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "v-unsupported");
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorCode).toBe("VERIFICATION_UNSUPPORTED");
    // Fail closed BEFORE execution: neither prepare nor execute ran.
    expect(adapter.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------- C. timeouts

  it("adapter execution exceeds effective timeout -> no false success, unresolved", async () => {
    setupAdapterCommand({ timeoutPolicy: { maxSeconds: 0.1, cancellable: true } });
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"], timeoutSeconds: 1 });
    adapter.executeMode = "hang";
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand({ timeoutPolicy: { maxSeconds: 0.1, cancellable: true } }), { url: "https://x" }, "t-exec");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("EXECUTION_TIMEOUT");
    expect(outcome.status).not.toBe("VERIFIED");
    // The adapter observed cooperative cancellation.
    expect(adapter.sawAbort).toBe(true);
    // Verification must not run after an execution timeout.
    expect(adapter.calls).not.toContain("verify");
  });

  it("adapter verification exceeds its timeout -> never VERIFIED", async () => {
    setupAdapterCommand({ timeoutPolicy: { maxSeconds: 1, cancellable: true } });
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"], timeoutSeconds: 0.1 });
    adapter.verifyMode = "hang";
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand({ timeoutPolicy: { maxSeconds: 1, cancellable: true } }), { url: "https://x" }, "t-verify");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("VERIFICATION_TIMEOUT");
    expect(outcome.status).not.toBe("VERIFIED");
  });

  it("preparation exceeds its timeout -> no execution begins", async () => {
    setupAdapterCommand({ timeoutPolicy: { maxSeconds: 0.1, cancellable: true } });
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"], timeoutSeconds: 1 });
    adapter.prepareMode = "hang";
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand({ timeoutPolicy: { maxSeconds: 0.1, cancellable: true } }), { url: "https://x" }, "t-prepare");
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.errorCode).toBe("PREPARE_TIMEOUT");
    // Execution must not begin after a prepare timeout.
    expect(adapter.calls).toContain("prepare");
    expect(adapter.calls).not.toContain("execute");
  });

  it("invalid timeout values fail closed before execution", async () => {
    setupAdapterCommand({ timeoutPolicy: { maxSeconds: 0, cancellable: true } });
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"], timeoutSeconds: 0 });
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand({ timeoutPolicy: { maxSeconds: 0, cancellable: true } }), { url: "https://x" }, "t-invalid");
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorCode).toBe("TIMEOUT_INVALID");
    expect(adapter.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------- D. lifecycle & idempotency

  it("repeated identical idempotency request returns the existing record without re-execution", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    env.services.gateway.registerAdapter(adapter);
    const def = baseCommand();

    const first = await submit(def, { url: "https://x" }, "idem-a");
    expect(first.status).toBe("VERIFIED");
    const callsAfterFirst = adapter.calls.length;

    const replay = await submit(def, { url: "https://x" }, "idem-a");
    expect(replay.executionId).toBe(first.executionId);
    expect(replay.status).toBe("VERIFIED");
    // No duplicate execution or verification.
    expect(adapter.calls.length).toBe(callsAfterFirst);
  });

  it("same idempotency key with a different canonical payload -> IDEMPOTENCY_CONFLICT", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    env.services.gateway.registerAdapter(adapter);
    const def = baseCommand();

    const first = await submit(def, { url: "https://a" }, "idem-b");
    expect(first.status).toBe("VERIFIED");

    const conflict = await submit(def, { url: "https://b" }, "idem-b");
    expect(conflict.status).toBe("BLOCKED");
    expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.executionId).not.toBe(first.executionId);
  });

  it("already-completed execution is replayed without duplicate execution or verification", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    env.services.gateway.registerAdapter(adapter);
    const def = baseCommand();

    const first = await submit(def, { url: "https://x" }, "idem-c");
    expect(first.status).toBe("VERIFIED");
    const callsAfterFirst = adapter.calls.length;

    const replay = await submit(def, { url: "https://x" }, "idem-c");
    expect(replay.executionId).toBe(first.executionId);
    expect(adapter.calls.length).toBe(callsAfterFirst);
  });

  it("internal built-in commands keep their existing behaviour", async () => {
    const outcome = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "int-1" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(outcome.status).toBe("VERIFIED");
    expect(outcome.commandId).toBe("platform.commands.list");
  });

  it("cross-workspace / unauthorised requests keep their denial behaviour", async () => {
    const stranger = createTestUser(env.services);
    const denied = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "x-1" },
      { userId: stranger.userId, workspaceId: business },
    );
    expect(denied.status).toBe("BLOCKED");
    expect(denied.errorCode).toBe("WORKSPACE_DENIED");

    const viewer = createTestUser(env.services);
    addMember(env.services, business, viewer.userId, "VIEWER", owner.userId);
    const permDenied = await env.services.gateway.submit(
      { commandId: "workspace.members.list", workspaceId: business, args: {}, idempotencyKey: "x-2" },
      { userId: viewer.userId, workspaceId: business },
    );
    expect(permDenied.status).toBe("BLOCKED");
    expect(permDenied.errorCode).toBe("PERMISSION_DENIED");
  });

  it("verification failure is persisted and audited", async () => {
    setupAdapterCommand();
    const adapter = new ControlledAdapter({ supportedCommands: ["browser.open"] });
    adapter.verifyResult = { verified: false, evidence: { checked: true }, reason: "not confirmed" };
    env.services.gateway.registerAdapter(adapter);

    const outcome = await submit(baseCommand(), { url: "https://x" }, "aud-1");
    expect(outcome.status).toBe("PARTIAL");

    const rec = env.services.lifecycle.get(outcome.executionId)!;
    expect(rec.status).toBe("PARTIAL");
    expect(rec.error_code).toBe("VERIFICATION_FAILED");
    expect(rec.evidence).toBeTruthy();

    const events = env.services.audit.list(business, 100);
    const verificationEvents = events.filter((e) => e.event_type === "COMMAND_VERIFICATION");
    expect(verificationEvents.length).toBeGreaterThan(0);
  });
});
