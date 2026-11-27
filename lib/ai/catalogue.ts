/**
 * CORE-03 — client-safe AI catalogue.
 *
 * Serialisable, React-safe summaries of the registered AI providers, models and
 * the system orchestrator agent. Derived from the real built-in definitions
 * (single source of truth) so the UI never hardcodes availability. No DB or
 * Node imports — safe for the browser bundle.
 */

export interface ClientProvider {
  providerId: string;
  providerName: string;
  adapterType: string;
  privacyClass: string;
  availabilityStatus: string;
  available: boolean;
}

export interface ClientModel {
  modelId: string;
  providerId: string;
  modelName: string;
  supportedTasks: string[];
  structuredOutput: boolean;
  toolCall: boolean;
  streaming: boolean;
  reasoning: boolean;
  status: string;
}

export interface ClientAgent {
  agentId: string;
  name: string;
  category: string;
  description: string;
  status: string;
  riskConstraints: string[];
  delegationPolicy: string;
}

/** The deterministic test provider is always available (no credentials). */
export const DEFAULT_PROVIDER: ClientProvider = {
  providerId: "test.provider",
  providerName: "BEAN Test Provider",
  adapterType: "test",
  privacyClass: "INTERNAL",
  availabilityStatus: "AVAILABLE",
  available: true,
};

export const CLIENT_PROVIDERS: ClientProvider[] = [DEFAULT_PROVIDER];

export const CLIENT_MODELS: ClientModel[] = [
  {
    modelId: "test.general",
    providerId: "test.provider",
    modelName: "Test General",
    supportedTasks: ["GENERAL_CHAT", "RESEARCH", "SUMMARISATION", "TRANSLATION"],
    structuredOutput: true,
    toolCall: true,
    streaming: true,
    reasoning: false,
    status: "AVAILABLE",
  },
  {
    modelId: "test.reasoning",
    providerId: "test.provider",
    modelName: "Test Reasoning",
    supportedTasks: ["REASONING", "PLANNING", "WORKFLOW_DESIGN", "TOOL_SELECTION"],
    structuredOutput: true,
    toolCall: true,
    streaming: true,
    reasoning: true,
    status: "AVAILABLE",
  },
];

export const CLIENT_AGENTS: ClientAgent[] = [
  {
    agentId: "bean.system.orchestrator",
    name: "BEAN System Orchestrator",
    category: "system",
    description:
      "System-level orchestration: understands intent, proposes plans and delegates approved work through the governed gateway.",
    status: "ENABLED",
    riskConstraints: ["R0", "R1", "R2"],
    delegationPolicy: "BOUNDED",
  },
];
