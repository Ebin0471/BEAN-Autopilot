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
// CORE-03 AI intelligence layer
import { ProviderRegistry } from "@/lib/ai/provider-registry";
import { ModelRegistry } from "@/lib/ai/model-registry";
import { ModelRouter } from "@/lib/ai/routing";
import { ConversationService } from "@/lib/ai/conversation";
import { IntentEngine } from "@/lib/ai/intent";
import { ContextAssembler } from "@/lib/ai/context";
import { PlanningEngine } from "@/lib/ai/planning";
import { AgentRegistry } from "@/lib/ai/agents";
import { AgentOrchestrator } from "@/lib/ai/orchestrator";
import { registerDefaultAIProviders } from "@/lib/ai/bootstrap";

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
  // CORE-03 AI intelligence layer
  aiProviders: ProviderRegistry;
  aiModels: ModelRegistry;
  aiRouter: ModelRouter;
  conversations: ConversationService;
  intent: IntentEngine;
  context: ContextAssembler;
  planner: PlanningEngine;
  agents: AgentRegistry;
  orchestrator: AgentOrchestrator;
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

  // CORE-03 AI intelligence layer.
  const aiProviders = new ProviderRegistry(db);
  const aiModels = new ModelRegistry(db);
  const aiRouter = new ModelRouter(aiProviders, aiModels);
  const conversations = new ConversationService(db, audit);
  const intent = new IntentEngine(aiRouter, aiProviders, aiModels);
  const context = new ContextAssembler(db, policy, commands, capabilities, aiModels);
  const planner = new PlanningEngine(db, aiRouter, aiProviders, aiModels, commands, capabilities, policy, risk);
  const agents = new AgentRegistry(db, commands, policy);
  const orchestrator = new AgentOrchestrator(db, audit, gateway, commands, capabilities, agents, planner, aiRouter, aiProviders, aiModels, conversations, intent, context, policy);

  registerDefaultAIProviders(aiProviders, aiModels, agents);

  return {
    db,
    audit,
    identity,
    session,
    workspace,
    permissions,
    policy,
    risk,
    passport,
    approval,
    commands,
    capabilities,
    lifecycle,
    gateway,
    aiProviders,
    aiModels,
    aiRouter,
    conversations,
    intent,
    context,
    planner,
    agents,
    orchestrator,
  };
}

/** Application-wide services using the default database. */
export function getServices(): Services {
  return createServices(getDb());
}
