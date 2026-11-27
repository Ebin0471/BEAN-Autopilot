// BEAN Autopilot — shared UI types (UI-01)

export type WorkspaceKind = "personal" | "professional" | "business";

export type NavKey =
  | "home"
  | "chat"
  | "agents"
  | "automation"
  | "connections"
  | "activity"
  | "files"
  | "settings";

export type AgentStatus = "planned" | "configured" | "available" | "active";

export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4";

export interface Agent {
  id: string;
  name: string;
  category: "universal" | "personal" | "professional" | "business";
  oneLiner: string;
  status: AgentStatus;
  riskClass: RiskClass;
  approval: string;
  connections: string[];
}

export type ConnectionState = "not-connected" | "available" | "connected";

export interface ConnectionSurface {
  id: string;
  name: string;
  icon: string;
  state: ConnectionState;
  note: string;
}

export type TaskState = "queued" | "pending" | "success" | "failed";

export interface ActivityItem {
  id: string;
  time: string;
  task: string;
  agent: string;
  command: string;
  approval: "not-required" | "requested" | "approved" | "denied";
  state: TaskState;
  evidence: string;
}

export type WorkflowNodeKind =
  | "trigger"
  | "agent"
  | "condition"
  | "action"
  | "approval"
  | "delay"
  | "verify"
  | "error";

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  title: string;
  x: number;
  y: number;
  note: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "system" | "assistant";
  text: string;
  /** marks a message that is explicitly a UI/demo notice, not a model reply */
  demo?: boolean;
}

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  icon: string;
}
