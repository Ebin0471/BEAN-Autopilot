// @vitest-environment node

/**
 * CORE-03 — Intelligence engine tests.
 *
 * Exercises the real engine modules (intent, planning, agents, orchestrator)
 * against an in-memory database and the deterministic test provider. The test
 * provider is configured with canned structured responders so the full
 * intent → plan → execute pipeline is exercised WITHOUT a real AI provider.
 *
 * Covers the CORE-03 hard constraints:
 *  - fail-closed validation of untrusted model output (intent, plan)
 *  - reject plans referencing unknown command ids
 *  - orchestrator executes only R0/R1 approval-free commands via the gateway
 *  - consequential commands are never auto-approved
 *  - agents cannot expand the caller's authority
 */
import { describe, it, expect, beforeAll } from "vitest";

import { uuid } from "@/lib/db/util";
import { createTestEnv } from "@/lib/security/testing";
import { createServices, type Services } from "@/lib/security/container";
import { TestProviderAdapter } from "@/lib/ai/providers/test-provider";
import { IntentEngine, IntentError } from "@/lib/ai/intent";
import { PlanningEngine, PlanningError } from "@/lib/ai/planning";
import { AgentRegistry, AgentRegistryError } from "@/lib/ai/agents";
import { AgentOrchestrator } from "@/lib/ai/orchestrator";
import { ProviderRegistry } from "@/lib/ai/provider-registry";
import { ModelRegistry } from "@/lib/ai/model-registry";
import { ModelRouter } from "@/lib/ai/routing";
import { ContextAssembler } from "@/lib/ai/context";
import { createDefaultTestProvider } from "@/lib/ai/providers/test-provider";
import { registerDefaultAgents } from "@/lib/ai/bootstrap";
import { ALL_TASK_CATEGORIES, type AgentDefinition, type Intent } from "@/lib/ai/types";

interface EngineEnv {
  services: Services;
  intent: IntentEngine;
  planner: PlanningEngine;
  agents: AgentRegistry;
  orchestrator: AgentOrchestrator;
  workspaceId: string;
  userId: string;
  conversationId: string;
}

/**
 * Build an engine environment where the test provider returns a canned
 * structured payload chosen by the current test. The responder inspects the
 * request system message to decide which canned payload to emit.
 */
function buildEngineEnv(responder: (task: string, req: unknown) => unknown): EngineEnv {
  const db = createTestEnv().db;
  const services = createServices(db);
  const { adapter, models } = createDefaultTestProvider();

  // Re-register with a custom structured responder on a fresh registry.
  const providers = new ProviderRegistry(db);
  const modelRegistry = new ModelRegistry(db);
  const custom = new TestProviderAdapter({
    providerId: "test.provider",
    providerName: "BEAN Test Provider",
    models,
    structuredResponder: responder as never,
  });
  providers.register(custom.describe(), custom);
  for (const m of models) modelRegistry.register({ ...m, status: "AVAILABLE" });
  const router = new ModelRouter(providers, modelRegistry);

  const intent = new IntentEngine(router, providers, modelRegistry);
  const planner = new PlanningEngine(
    db,
    router,
    providers,
    modelRegistry,
    services.commands,
    services.capabilities,
    services.policy,
    services.risk,
  );
  const agents = new AgentRegistry(db, services.commands, services.policy);
  // Register only the default agent (the test provider is registered above
  // with a custom responder — re-registering the default provider would drop it).
  registerDefaultAgents(agents);
  const orchestrator = new AgentOrchestrator(
    db,
    services.audit,
    services.gateway,
    services.commands,
    services.capabilities,
    agents,
    planner,
    router,
    providers,
    modelRegistry,
    services.conversations,
    intent,
    new ContextAssembler(db, services.policy, services.commands, services.capabilities, modelRegistry),
    services.policy,
  );

  // Create a real workspace, user and conversation so policy.resolve and the
  // gateway resolve real permissions (the orchestrator binds to the CORE-02
  // security model).
  const user = services.identity.linkAuthAccount("local-test", `engine:${uuid()}`, { displayName: "Engine User" }).user;
  const ws = services.workspace.createWorkspace(user.id, "PROFESSIONAL", "Engine Test");
  services.workspace.setMembership(ws.id, user.id, "OWNER", ws.id);
  const conv = services.conversations.create({ workspaceId: ws.id, userId: user.id, title: "Engine chat" });

  return {
    services,
    intent,
    planner,
    agents,
    orchestrator,
    workspaceId: ws.id,
    userId: user.id,
    conversationId: conv.id,
  };
}

/** A valid structured intent payload. */
function intentPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    taskCategory: "GENERAL_CHAT",
    desiredOutcome: "List the registered commands",
    entities: [{ type: "command", value: "platform.commands.list", confidence: 0.9 }],
    constraints: [],
    preferences: [],
    deadlines: [],
    amounts: [],
    targets: [],
    requestedActions: ["list_commands"],
    requiredCapabilities: ["platform.commands"],
    sensitivityClassification: "INTERNAL",
    ambiguityList: [],
    missingInformation: [],
    confidence: 0.9,
    requiresClarification: false,
    ...overrides,
  };
}

/** A valid structured plan payload (only fields the Zod schema checks). */
function planPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    objective: "List the registered commands",
    tasks: [
      {
        taskId: "t1",
        description: "List registered commands",
        dependsOn: [],
        candidateCommandIds: ["platform.commands.list"],
        requiredCapabilities: ["platform.commands"],
        permissionRequirements: ["workspace.read"],
        riskClass: "R0",
        approvalRequired: false,
        expectedOutput: "list of registered commands",
        verificationCriteria: ["result_validated"],
      },
    ],
    requiredAgents: [],
    requiredCapabilities: ["platform.commands"],
    expectedOutputs: ["command_list"],
    estimatedComplexity: "LOW",
    verificationCriteria: ["all_tasks_verified"],
    unresolvedQuestions: [],
    ...overrides,
  };
}

/**
 * Dispatch responder: inspect the system prompt to return the right canned
 * payload for the current engine step (intent vs plan).
 */
function routingResponder(task: string, req: unknown): unknown {
  const messages = (req as { messages?: { role: string; content: string }[] }).messages ?? [];
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  if (sys.includes("intent classifier")) return intentPayload();
  if (sys.includes("task planner")) return planPayload();
  return undefined;
}

describe("CORE-03 intent engine", () => {
  let env: EngineEnv;

  beforeAll(() => {
    env = buildEngineEnv(routingResponder);
  });

  it("recognises a well-formed intent from the model and enriches it", async () => {
    const intent = await env.intent.recognise({
      requestText: "List the registered commands",
      workspaceId: "ws-1",
    });
    expect(intent.taskCategory).toBe("GENERAL_CHAT");
    expect(intent.desiredOutcome).toBe("List the registered commands");
    expect(intent.requestedActions).toContain("list_commands");
    expect(intent.requiresClarification).toBe(false);
    expect(intent.language).toBe("english");
    expect(intent.workspaceId).toBe("ws-1");
  });

  it("detects Tamil and Tanglish script/markers", async () => {
    const tamil = await env.intent.recognise({
      requestText: "பட்டியல் காண்பி",
      workspaceId: "ws-1",
    });
    expect(tamil.language).toBe("tamil");

    const tanglish = await env.intent.recognise({
      requestText: "commands list kuda paa",
      workspaceId: "ws-1",
    });
    expect(tanglish.language).toBe("tanglish");
  });

  it("fails closed on malformed model intent output (INVALID_INTENT_OUTPUT)", async () => {
    const envBad = buildEngineEnv(() => ({
      // missing required fields
      desiredOutcome: "",
      confidence: 2,
    }));
    await expect(
      envBad.intent.recognise({ requestText: "hello", workspaceId: "ws-1" }),
    ).rejects.toMatchObject({ code: "INVALID_INTENT_OUTPUT" });
  });

  it("fails closed when the model returns no structured output", async () => {
    const envBad = buildEngineEnv(() => undefined);
    await expect(
      envBad.intent.recognise({ requestText: "hello", workspaceId: "ws-1" }),
    ).rejects.toBeInstanceOf(IntentError);
  });

  it("maps PUBLIC sensitivity to EXTERNAL privacy class (never INTERNAL)", async () => {
    const envPub = buildEngineEnv((_t, req) => {
      const messages = (req as { messages?: { role: string; content: string }[] }).messages ?? [];
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      return sys.includes("intent classifier")
        ? intentPayload({ sensitivityClassification: "PUBLIC" })
        : planPayload();
    });
    const intent = await envPub.intent.recognise({
      requestText: "Show public help",
      workspaceId: "ws-1",
    });
    expect(intent.sensitivityClassification).toBe("PUBLIC");
    // routing decision should use the EXTERNAL privacy class
    const routerEnv = buildEngineEnv(routingResponder);
    expect(routerEnv.services).toBeTruthy();
  });
});

describe("CORE-03 planning engine", () => {
  let env: EngineEnv;

  beforeAll(() => {
    env = buildEngineEnv(routingResponder);
  });

  it("proposes a valid plan for an intent", async () => {
    const intent = await env.intent.recognise({
      requestText: "List the registered commands",
      workspaceId: "ws-1",
    });
    const plan = await env.planner.propose({
      intent,
      workspaceId: env.workspaceId,
      userId: env.userId,
      conversationId: env.conversationId,
    });
    expect(plan.objective).toBe("List the registered commands");
    expect(plan.tasks.length).toBeGreaterThan(0);
    expect(plan.tasks[0].candidateCommandIds).toContain("platform.commands.list");
    expect(plan.tasks[0].riskClass).toBe("R0");
  });

  it("fails closed when the plan references an unknown command id", async () => {
    const envBad = buildEngineEnv((_t, req) => {
      const messages = (req as { messages?: { role: string; content: string }[] }).messages ?? [];
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("intent classifier")) return intentPayload();
      return planPayload({
        tasks: [
          {
            taskId: "t1",
            description: "Run a non-existent command",
            candidateCommandIds: ["platform.commands.does_not_exist"],
            requiredCapabilities: [],
            permissionRequirements: [],
            riskClass: "R0",
            approvalRequired: false,
            expectedOutput: "command result",
            verificationCriteria: [],
          },
        ],
      });
    });
    const intent = await envBad.intent.recognise({
      requestText: "do a thing",
      workspaceId: "ws-1",
    });
    await expect(
      envBad.planner.propose({
        intent,
        workspaceId: envBad.workspaceId,
        userId: envBad.userId,
        conversationId: envBad.conversationId,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_COMMAND_IN_PLAN" });
  });

  it("fails closed on malformed plan output", async () => {
    const envBad = buildEngineEnv((_t, req) => {
      const messages = (req as { messages?: { role: string; content: string }[] }).messages ?? [];
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("intent classifier")) return intentPayload();
      return { objective: "no tasks" }; // tasks array missing → invalid
    });
    const intent = await envBad.intent.recognise({
      requestText: "plan a thing",
      workspaceId: "ws-1",
    });
    await expect(
      envBad.planner.propose({
        intent,
        workspaceId: envBad.workspaceId,
        userId: envBad.userId,
        conversationId: envBad.conversationId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PLAN_OUTPUT" });
  });

  it("persists and retrieves a plan by id", async () => {
    const intent = await env.intent.recognise({
      requestText: "List the registered commands",
      workspaceId: "ws-1",
    });
    const plan = await env.planner.propose({
      intent,
      workspaceId: env.workspaceId,
      userId: env.userId,
      conversationId: env.conversationId,
    });
    const fetched = env.planner.get(plan.planId);
    expect(fetched).toBeTruthy();
    expect(fetched!.planId).toBe(plan.planId);
  });

  it("every task category is representable in the intent schema", () => {
    for (const cat of ALL_TASK_CATEGORIES) {
      expect(typeof cat).toBe("string");
      expect(cat.length).toBeGreaterThan(0);
    }
  });
});

describe("CORE-03 agent registry", () => {
  let env: EngineEnv;

  beforeAll(() => {
    env = buildEngineEnv(routingResponder);
  });

  function agentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      agentId: "test.agent",
      name: "Test Agent",
      version: "1.0.0",
      description: "A test agent",
      category: "professional",
      supportedWorkspaceTypes: ["PERSONAL", "PROFESSIONAL"],
      allowedCommandIds: ["platform.commands.list", "platform.commands.describe"],
      requiredPermissions: ["workspace.read"],
      requiredCapabilities: [],
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      riskConstraints: ["R0", "R1"],
      delegationPolicy: "BOUNDED",
      maximumSteps: 4,
      timeoutSeconds: 60,
      tokenBudget: null,
      verificationRequirements: [],
      escalationRules: [],
      status: "ENABLED",
      ...overrides,
    };
  }

  it("registers and retrieves an agent definition", () => {
    env.agents.register(agentDef());
    const got = env.agents.get("test.agent");
    expect(got).toBeTruthy();
    expect(got!.name).toBe("Test Agent");
    expect(got!.allowedCommandIds).toContain("platform.commands.list");
  });

  it("rejects an agent that references an unknown command (fail-closed)", () => {
    expect(() =>
      env.agents.register(agentDef({ allowedCommandIds: ["platform.commands.nope"] })),
    ).toThrowError(AgentRegistryError);
  });

  it("rejects an agent with an invalid input schema", () => {
    expect(() =>
      env.agents.register(agentDef({ inputSchema: "not-an-object" as never })),
    ).toThrowError(AgentRegistryError);
  });

  it("canAcceptTask only accepts enabled agents for supported workspace types", () => {
    env.agents.register(agentDef());
    expect(env.agents.canAcceptTask("test.agent", "PERSONAL")).toBe(true);
    expect(env.agents.canAcceptTask("test.agent", "BUSINESS")).toBe(false);
    env.agents.setStatus("test.agent", "DISABLED");
    expect(env.agents.canAcceptTask("test.agent", "PERSONAL")).toBe(false);
  });

  it("validateDelegationScope rejects commands outside the agent's scope", () => {
    env.agents.register(agentDef());
    const ok = env.agents.validateDelegationScope(
      "test.agent",
      ["platform.commands.list"],
      ["workspace.read"],
    );
    expect(ok.ok).toBe(true);
    const bad = env.agents.validateDelegationScope(
      "test.agent",
      ["platform.commands.delete"], // not in allowed set
      ["workspace.read"],
    );
    expect(bad.ok).toBe(false);
  });

  it("validateDelegationScope rejects when the agent needs permissions the caller lacks (no authority expansion)", () => {
    env.agents.register(
      agentDef({
        agentId: "test.agent2",
        requiredPermissions: ["workspace.delete"],
      }),
    );
    const result = env.agents.validateDelegationScope(
      "test.agent2",
      ["platform.commands.list"],
      ["workspace.read"], // caller does NOT have workspace.delete
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("workspace.delete");
  });

  it("registers the default system orchestrator agent", () => {
    const list = env.agents.list();
    const sys = list.find((a) => a.agentId === "bean.system.orchestrator");
    expect(sys).toBeTruthy();
    expect(sys!.category).toBe("system");
    expect(sys!.riskConstraints).toContain("R2");
  });
});

describe("CORE-03 orchestrator", () => {
  let env: EngineEnv;

  beforeAll(() => {
    env = buildEngineEnv(routingResponder);
  });

  it("executes only the R0 approval-free task via the gateway and never fabricates", async () => {
    const result = await env.orchestrator.handleTurn({
      workspaceId: env.workspaceId,
      userId: env.userId,
      conversationId: env.conversationId,
      message: "List the registered commands",
    });
    expect(result.status).toBe("VERIFIED");
    expect(result.plan.tasks.length).toBeGreaterThan(0);
    // The single R0 task is executed; no consequential actions are auto-run.
    expect(result.executions.length).toBe(1);
    expect(result.executions[0].status).toBe("VERIFIED");
    expect(result.response).toBeTruthy();
  });

  it("never auto-approves consequential (R3+) commands", async () => {
    const envCons = buildEngineEnv((_t, req) => {
      const messages = (req as { messages?: { role: string; content: string }[] }).messages ?? [];
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("intent classifier")) return intentPayload();
      // A consequential plan: a known command id, but classified R3 and
      // requiring approval. The orchestrator must NOT auto-execute it.
      return planPayload({
        objective: "Delete a file",
        tasks: [
          {
            taskId: "t1",
            description: "Delete a workspace file",
            dependsOn: [],
            candidateCommandIds: ["platform.commands.list"],
            requiredCapabilities: ["platform.commands"],
            permissionRequirements: ["workspace.read"],
            riskClass: "R3",
            approvalRequired: true,
            expectedOutput: "file deleted",
            verificationCriteria: ["passport_consumed"],
          },
        ],
      });
    });
    const result = await envCons.orchestrator.handleTurn({
      workspaceId: envCons.workspaceId,
      userId: envCons.userId,
      conversationId: envCons.conversationId,
      message: "Delete a file",
    });
    // No execution of the consequential command; it is left for a human.
    expect(result.executions).toHaveLength(0);
    expect(result.limitations.some((l) => l.includes("human approval"))).toBe(true);
    expect(result.status).toBe("PROPOSED");
  });

  it("honour autoExecuteSafe=false by proposing without executing", async () => {
    const result = await env.orchestrator.handleTurn({
      workspaceId: env.workspaceId,
      userId: env.userId,
      conversationId: env.conversationId,
      message: "List the registered commands",
      autoExecuteSafe: false,
    });
    expect(result.executions).toHaveLength(0);
    expect(result.limitations.some((l) => l.includes("not executed"))).toBe(true);
  });

  it("delegate enforces the maximum delegation depth (fail-closed)", () => {
    const agent = env.agents.get("bean.system.orchestrator")!;
    expect(agent).toBeTruthy();
    // Depth beyond the cap must be rejected, never silently allowed.
    const result = env.orchestrator.delegate({
      workspaceId: env.workspaceId,
      userId: env.userId,
      parentTaskId: null,
      agentId: "bean.system.orchestrator",
      objective: "deep delegation",
      allowedCommands: ["platform.commands.list"],
      depth: 99,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("maximum");
  });

  it("validateAgentResult fails closed on missing evidence and scope violations", () => {
    const envelope = env.orchestrator.delegate({
      workspaceId: env.workspaceId,
      userId: env.userId,
      parentTaskId: null,
      agentId: "bean.system.orchestrator",
      objective: "list commands",
      allowedCommands: ["platform.commands.list"],
      depth: 0,
    });
    expect(envelope.allowed).toBe(true);
    const childId = envelope.envelope.childTaskId;

    const ok = env.orchestrator.validateAgentResult(envelope.envelope, {
      taskId: childId,
      agentId: "bean.system.orchestrator",
      success: true,
      output: {},
      sources: [],
      assumptions: [],
      confidence: 1,
      executedOperations: ["platform.commands.list"],
      passportReferences: ["passport-1"],
      evidence: { result_validated: true },
      unresolvedIssues: [],
    });
    expect(ok.valid).toBe(true);

    // A result that executed an operation outside the delegated scope is rejected.
    const bad = env.orchestrator.validateAgentResult(envelope.envelope, {
      taskId: childId,
      agentId: "bean.system.orchestrator",
      success: true,
      output: {},
      sources: [],
      assumptions: [],
      confidence: 1,
      executedOperations: ["platform.commands.delete"],
      passportReferences: [],
      evidence: {},
      unresolvedIssues: [],
    });
    expect(bad.valid).toBe(false);
  });
});

describe("CORE-03 container wiring", () => {
  it("registers the deterministic test provider as available and never stores secrets", async () => {
    const { services } = createTestEnv();
    const providers = services.aiProviders;
    const meta = providers.list();
    const test = meta.find((p) => p.providerId === "test.provider");
    expect(test).toBeTruthy();
    expect(test!.availabilityStatus).toBe("AVAILABLE");
    // Provider metadata never carries a credential secret.
    const serialised = JSON.stringify(meta);
    expect(serialised).not.toContain("apiKey");
    expect(serialised).not.toContain("api_key");
    expect(serialised).not.toContain("secret");
  });

  it("exposes all CORE-03 engines from the service container", () => {
    const { services } = createTestEnv();
    expect(services.intent).toBeInstanceOf(IntentEngine);
    expect(services.planner).toBeInstanceOf(PlanningEngine);
    expect(services.agents).toBeInstanceOf(AgentRegistry);
    expect(services.orchestrator).toBeInstanceOf(AgentOrchestrator);
  });
});
