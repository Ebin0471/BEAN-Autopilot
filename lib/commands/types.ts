import type { z } from "zod";
import type { Permission, RiskClass, WorkspaceKind } from "@/lib/security/types";

/* ============================================================
   CORE-02 — Universal command & capability type definitions.
   One canonical command definition is reused by every interface
   (UI, CLI, JSON, MCP, agents). No per-interface copies.
   ============================================================ */

export type CommandCategory =
  | "platform"
  | "workspace"
  | "files"
  | "memory"
  | "agents"
  | "communication"
  | "finance"
  | "integration";

export type ExecutionMode = "SYNC" | "ASYNC" | "DRY_RUN" | "INTERACTIVE";

export type DeprecationStatus = "ACTIVE" | "DEPRECATED" | "RETIRED";

/** Verification contract: the evidence required to confirm an operation completed. */
export interface VerificationContract {
  /** How the result is checked: result_validation, read_after_write, external_receipt, manual. */
  type: "result_validation" | "read_after_write" | "external_receipt" | "manual";
  /** Human-readable description of the evidence required. */
  description: string;
  /** Whether an independent read-after-write check is required. */
  independentCheck: boolean;
}

/** Compensation contract: how to undo or remediate a partially completed operation. */
export interface CompensationContract {
  /** Whether compensation is supported. */
  supported: boolean;
  /** Human-readable description of the compensation action. */
  description: string;
}

export interface TimeoutPolicy {
  /** Maximum execution duration, in seconds. */
  maxSeconds: number;
  /** Whether the operation may be cancelled mid-execution. */
  cancellable: boolean;
}

export interface RateLimitPolicy {
  /** Maximum requests per window. */
  maxRequests: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface IdempotencyPolicy {
  /** Whether idempotency keys are enforced for this command. */
  enforced: boolean;
  /** Scope of the idempotency key (workspace-level by default). */
  scope: "workspace" | "actor" | "global";
}

/** A versioned, typed universal command definition. */
export interface CommandDefinition {
  commandId: string;
  version: string;
  name: string;
  description: string;
  category: CommandCategory;
  /** Zod schema for runtime input validation. */
  inputSchema: z.ZodTypeAny;
  /** Optional output shape (informational; not used for gating). */
  outputSchema?: z.ZodTypeAny;
  /** Capability required to execute, if any. Null for internal registry commands. */
  requiredCapability: string | null;
  /** Permissions the actor must hold in the workspace. */
  requiredPermissions: Permission[];
  /** Server-authoritative risk class. Never taken from the client. */
  serverRiskClass: RiskClass;
  /** Approval policy override (defaults derived from risk). */
  approvalPolicy: "NONE" | "SINGLE" | "DUAL";
  /** Target requirements (type/id presence). */
  targetRequirements: { required: boolean; type?: string };
  executionMode: ExecutionMode;
  timeoutPolicy: TimeoutPolicy;
  rateLimitPolicy: RateLimitPolicy;
  idempotencyPolicy: IdempotencyPolicy;
  verificationContract: VerificationContract;
  compensationContract: CompensationContract;
  availabilityRequirements: string[];
  deprecationStatus: DeprecationStatus;
  documentation: string;
}

/* ---------------- Capability registry ---------------- */

export type CapabilityCategory =
  | "browser"
  | "desktop"
  | "mobile"
  | "email"
  | "calendar"
  | "file"
  | "crm"
  | "erp"
  | "accounting"
  | "iot"
  | "platform"
  | "other";

export type CapabilityAvailability =
  | "PLANNED"
  | "REGISTERED"
  | "CONFIGURATION_REQUIRED"
  | "AVAILABLE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "DISABLED"
  | "REVOKED";

export type TrustLevel = "INTERNAL" | "VERIFIED" | "UNTRUSTED";

export interface CapabilityDefinition {
  capabilityId: string;
  version: string;
  name: string;
  category: CapabilityCategory;
  provider: string;
  description: string;
  /** commandIds this capability can serve. */
  supportedCommands: string[];
  inputSchema?: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  requiredScopes: Permission[];
  supportedWorkspaceTypes: WorkspaceKind[];
  riskConstraints: RiskClass[];
  availabilityStatus: CapabilityAvailability;
  healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  connectionRequirements: string[];
  rateLimits: RateLimitPolicy;
  timeoutLimits: TimeoutPolicy;
  verificationSupport: boolean;
  compensationSupport: boolean;
  documentation: string;
  trustLevel: TrustLevel;
}

/* ---------------- Command execution lifecycle ---------------- */

export type ExecutionState =
  | "RECEIVED"
  | "VALIDATING"
  | "VALIDATED"
  | "BLOCKED"
  | "AWAITING_APPROVAL"
  | "AUTHORISED"
  | "READY"
  | "RUNNING"
  | "VERIFYING"
  | "VERIFIED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "COMPENSATION_PENDING"
  | "COMPENSATED";

/** Explicitly valid lifecycle transitions. Invalid transitions fail. */
export const EXECUTION_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  RECEIVED: ["VALIDATING", "BLOCKED", "CANCELLED"],
  VALIDATING: ["VALIDATED", "BLOCKED", "FAILED", "CANCELLED"],
  VALIDATED: ["AWAITING_APPROVAL", "AUTHORISED", "BLOCKED", "CANCELLED"],
  BLOCKED: ["CANCELLED"],
  AWAITING_APPROVAL: ["AUTHORISED", "CANCELLED"],
  AUTHORISED: ["READY", "CANCELLED", "COMPENSATION_PENDING"],
  READY: ["RUNNING", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "PARTIAL", "CANCELLED"],
  VERIFYING: ["VERIFIED", "PARTIAL", "FAILED"],
  VERIFIED: [],
  PARTIAL: ["COMPENSATION_PENDING", "FAILED"],
  FAILED: ["COMPENSATION_PENDING"],
  CANCELLED: [],
  COMPENSATION_PENDING: ["COMPENSATED", "FAILED"],
  COMPENSATED: [],
};

/** A request to execute a command through the gateway. */
export interface CommandRequest {
  commandId: string;
  /** Optional version; defaults to the latest supported version. */
  version?: string;
  workspaceId: string;
  /** Validated command arguments. */
  args: Record<string, unknown>;
  targetType?: string;
  targetId?: string;
  idempotencyKey: string;
  agentId?: string | null;
  executionOptions?: Record<string, unknown>;
}
