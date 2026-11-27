import { BUILTIN_COMMANDS } from "./builtin";
import { BUILTIN_CAPABILITIES } from "./builtin-capabilities";

/* ============================================================
   Client-safe, serialisable summaries of the REAL registered
   command and capability catalogue. Derived from the same
   built-in definitions the server registry uses — one source
   of truth, no duplication. Safe to import in React components
   (no database, no node modules).
   ============================================================ */

export interface CommandSummary {
  commandId: string;
  version: string;
  name: string;
  category: string;
  description: string;
  requiredPermissions: string[];
  serverRiskClass: string;
  approvalPolicy: string;
  requiredCapability: string | null;
  executionMode: string;
  deprecationStatus: string;
}

export interface CapabilitySummary {
  capabilityId: string;
  version: string;
  name: string;
  category: string;
  provider: string;
  description: string;
  availabilityStatus: string;
  healthStatus: string;
  trustLevel: string;
  supportedCommands: string[];
  requiredScopes: string[];
}

export const COMMAND_CATALOGUE: CommandSummary[] = BUILTIN_COMMANDS.map((c) => ({
  commandId: c.commandId,
  version: c.version,
  name: c.name,
  category: c.category,
  description: c.description,
  requiredPermissions: c.requiredPermissions,
  serverRiskClass: c.serverRiskClass,
  approvalPolicy: c.approvalPolicy,
  requiredCapability: c.requiredCapability,
  executionMode: c.executionMode,
  deprecationStatus: c.deprecationStatus,
}));

export const CAPABILITY_CATALOGUE: CapabilitySummary[] = BUILTIN_CAPABILITIES.map((c) => ({
  capabilityId: c.capabilityId,
  version: c.version,
  name: c.name,
  category: c.category,
  provider: c.provider,
  description: c.description,
  availabilityStatus: c.availabilityStatus,
  healthStatus: c.healthStatus,
  trustLevel: c.trustLevel,
  supportedCommands: c.supportedCommands,
  requiredScopes: c.requiredScopes,
}));

export const RISK_LABEL: Record<string, string> = {
  R0: "R0 · Local draft",
  R1: "R1 · Read-only",
  R2: "R2 · Reversible",
  R3: "R3 · Consequential",
  R4: "R4 · Destructive",
};

export const AVAILABILITY_LABEL: Record<string, string> = {
  PLANNED: "Planned",
  REGISTERED: "Registered",
  CONFIGURATION_REQUIRED: "Configuration required",
  AVAILABLE: "Available",
  DEGRADED: "Degraded",
  UNAVAILABLE: "Unavailable",
  DISABLED: "Disabled",
  REVOKED: "Revoked",
};
