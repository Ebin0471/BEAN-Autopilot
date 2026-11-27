// CORE-01 — Security domain types. Single source of truth for roles,
// permissions, risk classes and workspace types used across services and API.

export type WorkspaceKind = "PERSONAL" | "PROFESSIONAL" | "BUSINESS";

export const WORKSPACE_KINDS: WorkspaceKind[] = ["PERSONAL", "PROFESSIONAL", "BUSINESS"];

/** Initial workspace roles (deny-by-default, least privilege). */
export type Role = "OWNER" | "ADMIN" | "OPERATOR" | "MEMBER" | "VIEWER";

export const ROLES: Role[] = ["OWNER", "ADMIN", "OPERATOR", "MEMBER", "VIEWER"];

/**
 * Explicit resource/action permission scopes. A permission is a tuple of
 * (resource, action). Unknown permissions are always denied.
 */
export type Permission =
  | "workspace.read"
  | "workspace.update"
  | "workspace.members.read"
  | "workspace.members.invite"
  | "workspace.members.manage"
  | "workspace.delete"
  | "files.read"
  | "files.write"
  | "memory.read"
  | "memory.write"
  | "agents.read"
  | "agents.configure"
  | "actions.request"
  | "actions.approve"
  | "actions.execute"
  | "audit.read"
  | "policy.manage"
  | "connections.manage";

export const PERMISSIONS: Permission[] = [
  "workspace.read",
  "workspace.update",
  "workspace.members.read",
  "workspace.members.invite",
  "workspace.members.manage",
  "workspace.delete",
  "files.read",
  "files.write",
  "memory.read",
  "memory.write",
  "agents.read",
  "agents.configure",
  "actions.request",
  "actions.approve",
  "actions.execute",
  "audit.read",
  "policy.manage",
  "connections.manage",
];

/** Risk classes. Determined and enforced server-side; clients cannot lower risk. */
export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4";

export const RISK_CLASSES: RiskClass[] = ["R0", "R1", "R2", "R3", "R4"];

export interface RiskPolicy {
  /** Whether explicit human approval is required before execution. */
  approvalRequired: boolean;
  /** Whether autonomous agent execution is permitted at this risk level. */
  autonomousExecution: boolean;
  /** Whether dual approval may be required (R4). */
  dualApprovalSupported: boolean;
}

/** Default approval rules per risk class. */
export const RISK_POLICY: Record<RiskClass, RiskPolicy> = {
  R0: { approvalRequired: false, autonomousExecution: true, dualApprovalSupported: false },
  R1: { approvalRequired: false, autonomousExecution: true, dualApprovalSupported: false },
  R2: { approvalRequired: false, autonomousExecution: true, dualApprovalSupported: false },
  R3: { approvalRequired: true, autonomousExecution: false, dualApprovalSupported: false },
  R4: { approvalRequired: true, autonomousExecution: false, dualApprovalSupported: true },
};

/** Action Passport lifecycle state machine. */
export type PassportState =
  | "REQUESTED"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "AUTHORISED"
  | "REJECTED"
  | "EXPIRED"
  | "REVOKED"
  | "CONSUMED"
  | "BLOCKED";

/** Explicitly valid state transitions. Any other transition must fail. */
export const PASSPORT_TRANSITIONS: Record<PassportState, PassportState[]> = {
  REQUESTED: ["PENDING_APPROVAL", "AUTHORISED", "REJECTED", "EXPIRED", "BLOCKED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED", "REVOKED", "BLOCKED"],
  APPROVED: ["AUTHORISED", "EXPIRED", "REVOKED", "BLOCKED"],
  AUTHORISED: ["CONSUMED", "EXPIRED", "REVOKED", "BLOCKED"],
  REJECTED: [],
  EXPIRED: [],
  REVOKED: [],
  CONSUMED: [],
  BLOCKED: [],
};

export type ActorType = "USER" | "AGENT";

export interface ActionRequest {
  workspaceId: string;
  targetType: string;
  targetId: string;
  command: string;
  operation: string;
  dataScope: string;
  permissionScope: Permission[];
  riskClass: RiskClass;
  /** Canonical parameter hash binding the passport to exact parameters. */
  paramHash: string;
  /** Complete validated command arguments, bound into the passport hash (CORE-02). */
  params?: Record<string, unknown>;
  /** Canonical binding payload string (CORE-02); computed by the gateway. */
  paramsCanonical?: string;
  /** Idempotency key to dedupe repeated requests. */
  idempotencyKey: string;
  approvalPolicy: "NONE" | "SINGLE" | "DUAL";
  verificationRequirements: string[];
  /** Agent identity when initiated by an agent (never expands authority). */
  agentId?: string | null;
}

export interface PassportApproval {
  approverId: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string | null;
  timestamp: string;
}
