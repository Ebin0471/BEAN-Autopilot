import type { Db } from "@/lib/db/database";
import { getDb } from "@/lib/db/database";
import { seedDefaults } from "@/lib/db/seed";
import { AuditService } from "./audit";
import { IdentityService } from "./identity";
import { SessionService } from "./session";
import { WorkspaceService } from "./workspace";
import { PermissionService } from "./permissions";
import { PolicyEngine } from "./policy";
import { RiskClassifier } from "./risk";
import { ActionPassportService } from "./passport";
import { ApprovalService } from "./approval";
import { CommandRegistry } from "@/lib/commands/registry";
import { CapabilityRegistry } from "@/lib/commands/capability";
import { ExecutionLifecycleManager } from "@/lib/commands/lifecycle";
import { CommandGateway } from "@/lib/commands/gateway";

export interface Services {
  db: Db;
  audit: AuditService;
  identity: IdentityService;
  session: SessionService;
  workspace: WorkspaceService;
  permissions: PermissionService;
  policy: PolicyEngine;
  risk: RiskClassifier;
  passport: ActionPassportService;
  approval: ApprovalService;
  // CORE-02 command & capability engine
  commands: CommandRegistry;
  capabilities: CapabilityRegistry;
  lifecycle: ExecutionLifecycleManager;
  gateway: CommandGateway;
}

/** Wire all services around a single database connection. */
export function createServices(db: Db): Services {
  seedDefaults(db);
  const audit = new AuditService(db);
  const identity = new IdentityService(db, audit);
  const session = new SessionService(db, audit);
  const workspace = new WorkspaceService(db, audit);
  const permissions = new PermissionService(db);
  const policy = new PolicyEngine(db);
  const risk = new RiskClassifier();
  const passport = new ActionPassportService(db, policy, audit, risk);
  const approval = new ApprovalService(passport);
  const commands = new CommandRegistry(db);
  const capabilities = new CapabilityRegistry(db);
  const lifecycle = new ExecutionLifecycleManager(db, audit);
  const gateway = new CommandGateway(db, policy, risk, passport, audit, commands, capabilities, lifecycle);
  return { db, audit, identity, session, workspace, permissions, policy, risk, passport, approval, commands, capabilities, lifecycle, gateway };
}

/** Application-wide services using the default database. */
export function getServices(): Services {
  return createServices(getDb());
}
