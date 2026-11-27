/**
 * CORE-03 — AI intelligence layer type foundation.
 *
 * Provider-neutral types for the AI subsystem: providers, models, requests,
 * responses, streaming events, usage, intent, plans and agent delegation.
 * These types are shared across the provider registry, model registry, routing
 * engine, conversation service, intent engine, planner, agent registry and
 * orchestrator.
 */

/* ------------------------------------------------------------------ */
/* Modalities & task categories                                        */
/* ------------------------------------------------------------------ */

export type Modality =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "structured";

export type TaskCategory =
  | "GENERAL_CHAT"
  | "RESEARCH"
  | "REASONING"
  | "PLANNING"
  | "CODING"
  | "DOCUMENT_ANALYSIS"
  | "TRANSLATION"
  | "SUMMARISATION"
  | "IMAGE_UNDERSTANDING"
  | "AUDIO_UNDERSTANDING"
  | "VOICE_INTERACTION"
  | "TOOL_SELECTION"
  | "WORKFLOW_DESIGN";

export const ALL_TASK_CATEGORIES: TaskCategory[] = [
  "GENERAL_CHAT",
  "RESEARCH",
  "REASONING",
  "PLANNING",
  "CODING",
  "DOCUMENT_ANALYSIS",
  "TRANSLATION",
  "SUMMARISATION",
  "IMAGE_UNDERSTANDING",
  "AUDIO_UNDERSTANDING",
  "VOICE_INTERACTION",
  "TOOL_SELECTION",
  "WORKFLOW_DESIGN",
];

/* ------------------------------------------------------------------ */
/* Provider & model metadata                                           */
/* ------------------------------------------------------------------ */

export type ProviderAvailability =
  | "PLANNED"
  | "REGISTERED"
  | "CONFIGURATION_REQUIRED"
  | "AVAILABLE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "DISABLED"
  | "REVOKED";

export type ProviderHealth =
  | "UNKNOWN"
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "FAILING";

export type PrivacyClass = "INTERNAL" | "LOCAL" | "EXTERNAL";

export interface RateLimitMetadata {
  maxRequests?: number;
  windowSeconds?: number;
}

export interface ProviderMetadata {
  providerId: string;
  providerName: string;
  version: string;
  adapterType: "native" | "openai-compatible" | "local" | "test";
  /** Reference to endpoint configuration — never a secret. */
  endpointRef: string | null;
  /** Reference to authentication configuration — never a secret. */
  authRef: string | null;
  supportedModalities: Modality[];
  streamingSupported: boolean;
  structuredOutputSupported: boolean;
  /** How structured output is obtained: native schema, prompted JSON, or none. */
  structuredOutputMode: StructuredOutputMode;
  toolCallSupported: boolean;
  contextWindow: number | null;
  rateLimit: RateLimitMetadata | null;
  privacyClass: PrivacyClass;
  availabilityStatus: ProviderAvailability;
  healthStatus: ProviderHealth;
}

/**
 * Structured-output modes. NATIVE_JSON_SCHEMA means the provider enforces a
 * JSON schema natively. PROMPTED_JSON means Autopilot requests a JSON object
 * in text and parses it (the model is not schema-constrained). NONE means no
 * structured output is supported.
 */
export type StructuredOutputMode = "NONE" | "PROMPTED_JSON" | "NATIVE_JSON_SCHEMA";

export type ModelStatus = "REGISTERED" | "AVAILABLE" | "DISABLED";

export interface ModelMetadata {
  modelId: string;
  providerId: string;
  modelName: string;
  modelVersion: string;
  supportedTasks: TaskCategory[];
  supportedModalities: Modality[];
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  structuredOutput: boolean;
  /** Structured-output mode for this model (NATIVE / PROMPTED / NONE). */
  structuredOutputMode: StructuredOutputMode;
  toolCall: boolean;
  streaming: boolean;
  reasoning: boolean;
  latencyMetadata: Record<string, unknown> | null;
  costMetadata: Record<string, unknown> | null;
  privacyClass: PrivacyClass;
  status: ModelStatus;
  availabilityEvidence: string | null;
}

export interface ProviderHealthResult {
  providerId: string;
  healthy: boolean;
  health: ProviderHealth;
  latencyMs: number | null;
  message: string;
  checkedAt: string;
}

/* ------------------------------------------------------------------ */
/* Requests, responses & streaming                                    */
/* ------------------------------------------------------------------ */

export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional structured payload (plan, tool calls, tool results). */
  structured?: unknown;
}

export interface ToolCallProposal {
  callId: string;
  commandId: string;
  version?: string;
  args: Record<string, unknown>;
  /** Model-proposed rationale (untrusted; never authorises anything). */
  rationale?: string;
}

export interface AIRequest {
  requestId: string;
  modelId: string;
  messages: AIMessage[];
  taskCategory: TaskCategory;
  /** Requested output shape for structured responses. */
  responseSchema?: Record<string, unknown>;
  /** Tool proposals the model may return (server-validated later). */
  tools?: ToolCallProposal[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** How token counts were determined — never confuse estimate with exact. */
export type UsageAccuracy =
  | "PROVIDER_REPORTED_EXACT"
  | "PROVIDER_REPORTED_ESTIMATE"
  | "APPLICATION_ESTIMATE"
  | "UNKNOWN";

export interface UsageMetadata {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Truthful provenance of the counts above. */
  accuracy: UsageAccuracy;
}

export interface AIResponse {
  requestId: string;
  modelId: string;
  providerId: string;
  content: string;
  structured?: unknown;
  toolCalls: ToolCallProposal[];
  usage: UsageMetadata;
  latencyMs: number;
  /** True when the router fell back to a different provider/model. */
  fallbackUsed: boolean;
  fallbackFrom?: string;
  error?: { code: string; message: string };
}

export type AIStreamEventType =
  | "delta"
  | "structured"
  | "tool_call"
  | "progress"
  | "complete"
  | "error"
  | "cancelled";

export interface AIStreamEvent {
  type: AIStreamEventType;
  requestId: string;
  delta?: string;
  content?: string;
  structured?: unknown;
  toolCall?: ToolCallProposal;
  usage?: UsageMetadata;
  error?: { code: string; message: string };
}

/* ------------------------------------------------------------------ */
/* Provider adapter contract                                          */
/* ------------------------------------------------------------------ */

export interface AIProviderAdapter {
  describe(): ProviderMetadata;
  listModels(): Promise<ModelMetadata[]>;
  healthCheck(): Promise<ProviderHealthResult>;
  generate(request: AIRequest): Promise<AIResponse>;
  stream(request: AIRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent>;
  cancel?(requestId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Routing                                                            */
/* ------------------------------------------------------------------ */

export type RoutingMode = "AUTO" | "MANUAL";

export interface RoutingConstraints {
  taskCategory: TaskCategory;
  requiredModalities: Modality[];
  requireStructuredOutput: boolean;
  requireToolCall: boolean;
  requireReasoning: boolean;
  maxContextTokens?: number;
  privacyClass?: PrivacyClass;
  preferredModelId?: string;
  budgetLimitTokens?: number;
}

export interface RoutingDecision {
  modelId: string;
  providerId: string;
  model: ModelMetadata;
  provider: ProviderMetadata;
  reason: string;
  fallbackChain: string[];
  fallbackUsed: boolean;
}

/* ------------------------------------------------------------------ */
/* Intent                                                             */
/* ------------------------------------------------------------------ */

export type SensitivityClassification =
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "PERSONAL"
  | "PUBLIC";

export interface IntentEntity {
  type: string;
  value: string;
  confidence: number;
}

export interface Intent {
  intentId: string;
  requestText: string;
  language: string;
  workspaceId: string;
  taskCategory: TaskCategory;
  desiredOutcome: string;
  entities: IntentEntity[];
  constraints: string[];
  preferences: string[];
  deadlines: string[];
  amounts: string[];
  targets: string[];
  requestedActions: string[];
  requiredCapabilities: string[];
  sensitivityClassification: SensitivityClassification;
  ambiguityList: string[];
  missingInformation: string[];
  confidence: number;
  requiresClarification: boolean;
}

/* ------------------------------------------------------------------ */
/* Planning                                                           */
/* ------------------------------------------------------------------ */

export type PlanStatus =
  | "PROPOSED"
  | "VALIDATED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "COMPLETED"
  | "VERIFIED"
  | "FAILED"
  | "PARTIAL";

export interface PlanTask {
  taskId: string;
  description: string;
  dependsOn: string[];
  parallelisable: boolean;
  requiredAgentId: string | null;
  candidateCommandIds: string[];
  requiredCapabilities: string[];
  permissionRequirements: string[];
  riskClass: string;
  approvalRequired: boolean;
  expectedOutput: string;
  verificationCriteria: string[];
  humanCheckpoint: boolean;
}

export interface TaskPlan {
  planId: string;
  conversationId: string;
  workspaceId: string;
  objective: string;
  tasks: PlanTask[];
  requiredAgents: string[];
  requiredCapabilities: string[];
  candidateCommands: string[];
  permissionRequirements: string[];
  riskClassification: string;
  approvalRequirements: string[];
  expectedOutputs: string[];
  verificationCriteria: string[];
  estimatedComplexity: "LOW" | "MEDIUM" | "HIGH";
  unresolvedQuestions: string[];
  status: PlanStatus;
}

/* ------------------------------------------------------------------ */
/* Agent registry & delegation                                       */
/* ------------------------------------------------------------------ */

export type AgentLifecycleStatus =
  | "DRAFT"
  | "REGISTERED"
  | "VALIDATED"
  | "ENABLED"
  | "DISABLED"
  | "DEPRECATED";

export interface AgentDefinition {
  agentId: string;
  name: string;
  version: string;
  description: string;
  category: "universal" | "personal" | "professional" | "business" | "system";
  supportedWorkspaceTypes: string[];
  allowedCommandIds: string[];
  requiredPermissions: string[];
  requiredCapabilities: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  riskConstraints: string[];
  delegationPolicy: "NONE" | "SINGLE" | "BOUNDED";
  maximumSteps: number;
  timeoutSeconds: number;
  tokenBudget: number | null;
  verificationRequirements: string[];
  escalationRules: string[];
  status: AgentLifecycleStatus;
}

export interface DelegationEnvelope {
  parentTaskId: string | null;
  childTaskId: string;
  initiatingUserId: string;
  workspaceId: string;
  objective: string;
  allowedContext: string[];
  allowedCommands: string[];
  permissionScope: string[];
  capabilityConstraints: string[];
  riskCeiling: string;
  deadline: string | null;
  maximumSteps: number;
  expectedResultSchema: Record<string, unknown>;
  verificationRequirements: string[];
  depth: number;
}

export interface AgentResult {
  taskId: string;
  agentId: string;
  success: boolean;
  output: unknown;
  sources: string[];
  assumptions: string[];
  confidence: number;
  executedOperations: string[];
  passportReferences: string[];
  evidence: Record<string, unknown>;
  unresolvedIssues: string[];
  errorCode?: string;
}

/* ------------------------------------------------------------------ */
/* Conversation                                                       */
/* ------------------------------------------------------------------ */

export type ConversationStatus = "ACTIVE" | "ARCHIVED" | "DELETED";

export interface Conversation {
  id: string;
  workspaceId: string;
  userId: string;
  title: string;
  status: ConversationStatus;
  selectedModelId: string | null;
  selectedProviderId: string | null;
  routingMode: RoutingMode;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  structured: unknown;
  modelId: string | null;
  providerId: string | null;
  usage: UsageMetadata | null;
  status: "PENDING" | "STREAMING" | "COMPLETED" | "FAILED" | "CANCELLED";
  errorCode: string | null;
  createdAt: string;
  seq: number;
}

/** Permission-aware minimal context bundle assembled for a planning turn. */
export interface ContextBundle {
  workspace: { id: string; kind: string; name: string } | null;
  commands: Array<{ commandId: string; version: string; category: string; requiredPermissions: string[] }>;
  capabilities: Array<{ capabilityId: string; availabilityStatus: string }>;
  models: Array<{ modelId: string; modelName: string; supportedTasks: string[] }>;
  tokenEstimate: number;
  sources: string[];
  notes: string[];
}
