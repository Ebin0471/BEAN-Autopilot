import type { ProviderRegistry } from "./provider-registry";
import type { ModelRegistry } from "./model-registry";
import type { AgentRegistry } from "./agents";
import { createDefaultTestProvider } from "./providers/test-provider";
import { loadProviderConfigs } from "./config";
import type { ProviderMetadata, PrivacyClass, AgentDefinition } from "./types";

/**
 * Register the default AI providers and models into the registries.
 *
 * The deterministic test provider is always registered and available (no
 * credentials, no external dependency), so the CORE-03 pipeline is exercisable
 * out of the box. Optional local / BEAN Intelligence providers are registered
 * as CONFIGURATION_REQUIRED when their endpoint env vars are present — they are
 * never pretend-connected; their real adapters arrive when a contract exists.
 */
/** Register only the minimum genuine system-level agents (no providers). */
export function registerDefaultAgents(agents: AgentRegistry): void {
  agents.register(systemOrchestratorAgent());
}

export function registerDefaultAIProviders(
  providers: ProviderRegistry,
  models: ModelRegistry,
  agents?: AgentRegistry,
): void {
  // 1. Deterministic test provider (always available).
  const { adapter, models: testModels } = createDefaultTestProvider();
  providers.register(adapter.describe(), adapter);
  for (const m of testModels) {
    models.register({ ...m, status: "AVAILABLE" });
  }

  // 2. Minimum genuine system-level orchestration agent (NOT the 117-agent
  //    workforce — DOC-02 remains incomplete and is not fabricated).
  if (agents) registerDefaultAgents(agents);

  // 2. Optional configured providers (env-driven, opt-in).
  for (const cfg of loadProviderConfigs()) {
    if (cfg.providerId === "test.provider") continue;
    if (!cfg.enabled) continue;
    const meta: ProviderMetadata = {
      providerId: cfg.providerId,
      providerName: cfg.providerName,
      version: "1.0.0",
      adapterType: cfg.adapterType,
      endpointRef: cfg.baseUrl ? `env:${cfg.providerId}.baseUrl` : null,
      authRef: cfg.apiKeyEnv ? `env:${cfg.apiKeyEnv}` : null,
      supportedModalities: ["text", "structured"],
      streamingSupported: true,
      structuredOutputSupported: true,
      toolCallSupported: true,
      contextWindow: 128000,
      rateLimit: null,
      privacyClass: cfg.privacyClass as PrivacyClass,
      // CONFIGURATION_REQUIRED until a real adapter/contract is supplied.
      availabilityStatus: "CONFIGURATION_REQUIRED",
      healthStatus: "UNKNOWN",
    };
    // No real adapter yet — register the definition only. Do not claim connected.
    providers.register(meta, {
      describe: () => meta,
      listModels: () => Promise.resolve([]),
      healthCheck: () =>
        Promise.resolve({
          providerId: cfg.providerId,
          healthy: false,
          health: "UNKNOWN",
          latencyMs: null,
          message: "Provider is registered but no adapter contract is available yet.",
          checkedAt: new Date().toISOString(),
        }),
      generate: () => {
        throw new Error(`Provider ${cfg.providerId} has no adapter contract yet.`);
      },
      stream: async function* () {
        throw new Error(`Provider ${cfg.providerId} has no adapter contract yet.`);
      },
    });
    void models; // models for these providers are registered when adapters land
  }
}

/**
 * The minimum genuine system-level orchestration agent. It coordinates planning
 * and delegates approved work to registered agents. It does NOT pretend to be
 * the 117 specialist agents (DOC-02 remains incomplete).
 */
function systemOrchestratorAgent(): AgentDefinition {
  return {
    agentId: "bean.system.orchestrator",
    name: "BEAN System Orchestrator",
    version: "1.0.0",
    description:
      "System-level orchestration component: understands intent, proposes plans, and delegates approved work to registered agents through the governed CORE-02 gateway.",
    category: "system",
    supportedWorkspaceTypes: ["PERSONAL", "PROFESSIONAL", "BUSINESS"],
    allowedCommandIds: [
      "platform.commands.list",
      "platform.commands.describe",
      "platform.capabilities.list",
      "platform.capabilities.describe",
      "platform.command.validate",
      "platform.command.preview",
      "workspace.members.list",
      "workspace.audit.list",
    ],
    requiredPermissions: ["workspace.read", "actions.execute"],
    requiredCapabilities: [],
    inputSchema: { type: "object", properties: { objective: { type: "string" } } },
    outputSchema: {
      type: "object",
      properties: {
        plan: { type: "object" },
        executions: { type: "array" },
        response: { type: "string" },
      },
    },
    riskConstraints: ["R0", "R1", "R2"],
    delegationPolicy: "BOUNDED",
    maximumSteps: 8,
    timeoutSeconds: 120,
    tokenBudget: null,
    verificationRequirements: ["result_validation"],
    escalationRules: ["Consequential (R3+) actions require human approval."],
    status: "ENABLED",
  };
}
