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
  return { db, audit, identity, session, workspace, permissions, policy, risk, passport, approval };
}

/** Application-wide services using the default database. */
export function getServices(): Services {
  return createServices(getDb());
}
