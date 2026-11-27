// @vitest-environment node

/**
 * CORE-02 Gate B — idempotency hardening regression tests.
 *
 * Verifies that an idempotency key is scoped to the COMPLETE canonical request,
 * not just (workspace, key). The same key reused for a different canonical
 * payload (command, arguments, capability, target, version or execution
 * options) must be rejected with an explicit conflict and must never return an
 * unrelated prior execution receipt or passport.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestEnv,
  createTestUser,
  createWorkspace,
  addMember,
  type TestEnv,
} from "@/lib/security/testing";
import { IdempotencyConflictError } from "@/lib/commands/canonical";
import type { Permission } from "@/lib/security/types";
import { TestCommandAdapter } from "@/lib/commands/adapter";

describe("CORE-02 idempotency hardening", () => {
  let env: TestEnv;
  let owner: ReturnType<typeof createTestUser>;
  let business: string;

  beforeEach(() => {
    env = createTestEnv();
    owner = createTestUser(env.services);
    business = createWorkspace(env.services, owner.userId, "BUSINESS", "Co");
  });

  it("REQ-1: same workspace + same key + same canonical request replays the existing execution", async () => {
    const req = {
      commandId: "platform.commands.list",
      workspaceId: business,
      args: {},
      idempotencyKey: "idem-same",
    };
    const first = await env.services.gateway.submit(req, {
      userId: owner.userId,
      workspaceId: business,
    });
    expect(first.status).toBe("VERIFIED");

    const replay = await env.services.gateway.submit(req, {
      userId: owner.userId,
      workspaceId: business,
    });
    expect(replay.status).toBe("VERIFIED");
    expect(replay.executionId).toBe(first.executionId);
  });

  it("REQ-2: same key + different command is rejected with an explicit conflict", async () => {
    const first = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "idem-cmd" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(first.status).toBe("VERIFIED");

    const conflict = await env.services.gateway.submit(
      { commandId: "platform.commands.describe", workspaceId: business, args: { commandId: "x" }, idempotencyKey: "idem-cmd" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(conflict.status).toBe("BLOCKED");
    expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    // The unrelated prior receipt is NOT returned.
    expect(conflict.executionId).not.toBe(first.executionId);
  });

  it("REQ-3: same key + different arguments is rejected with an explicit conflict", async () => {
    // platform.commands.list takes an optional { category } arg.
    const first = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "idem-args" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(first.status).toBe("VERIFIED");

    const conflict = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: { category: "platform" }, idempotencyKey: "idem-args" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(conflict.status).toBe("BLOCKED");
    expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.executionId).not.toBe(first.executionId);
  });

  it("REQ-4: same key + different target is rejected with an explicit conflict", async () => {
    // platform.commands.list accepts targetType/targetId in the request shape.
    const first = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, targetType: "a", targetId: "1", idempotencyKey: "idem-target" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(first.status).toBe("VERIFIED");

    const conflict = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, targetType: "b", targetId: "2", idempotencyKey: "idem-target" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(conflict.status).toBe("BLOCKED");
    expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("REQ-4: same key + different command version is rejected with an explicit conflict", async () => {
    // platform.commands.list resolves to version 1.0.0 when version is omitted.
    const first = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "idem-ver" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(first.status).toBe("VERIFIED");

    // A different version makes the canonical payload differ for the same key,
    // so the gateway rejects it with an explicit conflict (the key is already
    // bound to a different request) rather than returning the prior receipt.
    const conflict = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, version: "9.9.9", idempotencyKey: "idem-ver" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(conflict.status).toBe("BLOCKED");
    expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.executionId).not.toBe(first.executionId);
  });

  it("REQ-6: no unrelated previous execution receipt is returned for a different request", async () => {
    const first = await env.services.gateway.submit(
      { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "idem-unrelated" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(first.status).toBe("VERIFIED");

    // Same key, different command — must NOT surface the first execution id.
    const conflict = await env.services.gateway.submit(
      { commandId: "platform.capabilities.list", workspaceId: business, args: {}, idempotencyKey: "idem-unrelated" },
      { userId: owner.userId, workspaceId: business },
    );
    expect(conflict.status).toBe("BLOCKED");
    expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.executionId).not.toBe(first.executionId);
    expect(conflict.executionId).toBe("");
  });

  it("REQ-1: same key + same payload returns the existing PASSPORT (not a new one)", async () => {
    const req = {
      commandId: "platform.commands.list",
      workspaceId: business,
      args: {},
      idempotencyKey: "idem-passport",
    };
    const first = await env.services.gateway.submit(req, {
      userId: owner.userId,
      workspaceId: business,
    });
    expect(first.passportId).toBeTruthy();

    const replay = await env.services.gateway.submit(req, {
      userId: owner.userId,
      workspaceId: business,
    });
    // The passport service compared the canonical binding and returned the same one.
    expect(replay.passportId).toBe(first.passportId);
  });

  it("REQ-2/3: passport service raises IdempotencyConflictError on a canonical mismatch", () => {
    const action = (command: string, params: Record<string, unknown>) => ({
      workspaceId: business,
      targetType: "none",
      targetId: "none",
      command,
      operation: "op",
      dataScope: business,
      permissionScope: ["workspace.read"] as ["workspace.read"],
      riskClass: "R1" as const,
      paramHash: "hash-" + command,
      paramsCanonical: JSON.stringify({ command, params }),
      idempotencyKey: "passport-conflict",
      approvalPolicy: "NONE" as const,
      verificationRequirements: [],
    });

    const { passport } = env.services.passport.createRequest(
      { userId: owner.userId, workspaceId: business },
      action("invoice.send", { amount: 1000 }),
    );
    expect(passport.command).toBe("invoice.send");

    // Same key, different command -> conflict.
    expect(() =>
      env.services.passport.createRequest(
        { userId: owner.userId, workspaceId: business },
        action("invoice.refund", { amount: 1000 }),
      ),
    ).toThrow(IdempotencyConflictError);

    // Same key, same command, different params -> conflict.
    expect(() =>
      env.services.passport.createRequest(
        { userId: owner.userId, workspaceId: business },
        action("invoice.send", { amount: 2000 }),
      ),
    ).toThrow(IdempotencyConflictError);
  });

  it("REQ-1: lifecycle manager returns the existing record for an identical payload", () => {
    const input = {
      workspaceId: business,
      actorId: owner.userId,
      commandId: "platform.commands.list",
      commandVersion: "1.0.0",
      capabilityId: null,
      targetType: null,
      targetId: null,
      paramsHash: "abc123",
      idempotencyKey: "lc-same",
    };
    const first = env.services.lifecycle.create(input);
    const replay = env.services.lifecycle.create(input);
    expect(replay.id).toBe(first.id);
  });

  it("REQ-2/3/4: lifecycle manager raises a conflict for a mismatched canonical payload", () => {
    env.services.lifecycle.create({
      workspaceId: business,
      actorId: owner.userId,
      commandId: "platform.commands.list",
      commandVersion: "1.0.0",
      paramsHash: "hash-A",
      idempotencyKey: "lc-conflict",
    });
    expect(() =>
      env.services.lifecycle.create({
        workspaceId: business,
        actorId: owner.userId,
        commandId: "platform.commands.describe",
        commandVersion: "1.0.0",
        paramsHash: "hash-B",
        idempotencyKey: "lc-conflict",
      }),
    ).toThrow(IdempotencyConflictError);
  });

  it("REQ-5: concurrent duplicate requests produce a single consistent execution (no double passport)", async () => {
    // Register a deterministic adapter-backed command to exercise the
    // passport + lifecycle path under concurrency.
    const adapter = new TestCommandAdapter({
      adapterId: "test-concurrent",
      supportedCommands: ["platform.commands.list"],
      requiredPermissions: ["workspace.read"],
    });
    env.services.gateway.registerAdapter(adapter);

    const req = {
      commandId: "platform.commands.list",
      workspaceId: business,
      args: {},
      idempotencyKey: "idem-concurrent",
    };
    const actor = { userId: owner.userId, workspaceId: business };

    // Fire several concurrent identical submissions.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => env.services.gateway.submit(req, actor)),
    );

    // All succeed and share the SAME execution id (no inconsistent records).
    const ids = new Set(results.map((r) => r.executionId));
    expect(ids.size).toBe(1);
    for (const r of results) {
      expect(r.status).toBe("VERIFIED");
    }

    // Exactly one execution record exists for this key in the workspace.
    const records = env.services.lifecycle.list(business, 100).filter(
      (r) => r.idempotency_key === "idem-concurrent",
    );
    expect(records.length).toBe(1);
  });

  it("REQ-5: concurrent same-key DIFFERENT-payload requests do not corrupt records", async () => {
    const actor = { userId: owner.userId, workspaceId: business };
    // Two different payloads racing on the same key: exactly one wins, the
    // other must surface a conflict (or, if it lands first, the first wins and
    // the second conflicts). No inconsistent double record.
    const results = await Promise.all([
      env.services.gateway.submit(
        { commandId: "platform.commands.list", workspaceId: business, args: {}, idempotencyKey: "idem-race" },
        actor,
      ),
      env.services.gateway.submit(
        { commandId: "platform.capabilities.list", workspaceId: business, args: {}, idempotencyKey: "idem-race" },
        actor,
      ),
    ]);

    const statuses = results.map((r) => r.status).sort();
    // One VERIFIED, one BLOCKED(conflict) — never two VERIFIED records.
    expect(statuses).toEqual(["BLOCKED", "VERIFIED"]);
    const verified = results.find((r) => r.status === "VERIFIED")!;
    const blocked = results.find((r) => r.status === "BLOCKED")!;
    expect(blocked.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(blocked.executionId).not.toBe(verified.executionId);

    const records = env.services.lifecycle.list(business, 100).filter(
      (r) => r.idempotency_key === "idem-race",
    );
    expect(records.length).toBe(1);
  });
});
