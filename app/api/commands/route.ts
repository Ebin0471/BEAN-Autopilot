import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** GET /api/commands?category=... — list registered commands (discovery). */
export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const category = new URL(req.url).searchParams.get("category") ?? undefined;
  const commands = services.commands.list(category).map((c) => ({
    commandId: c.commandId,
    version: c.version,
    name: c.name,
    category: c.category,
    requiredPermissions: c.requiredPermissions,
    serverRiskClass: c.serverRiskClass,
    approvalPolicy: c.approvalPolicy,
    requiredCapability: c.requiredCapability,
    deprecationStatus: c.deprecationStatus,
  }));
  return json({ commands });
}

const ExecuteSchema = z.object({
  commandId: z.string().min(1),
  version: z.string().optional(),
  workspaceId: z.string().min(1),
  args: z.record(z.unknown()),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  idempotencyKey: z.string().min(1),
  agentId: z.string().optional(),
});

/**
 * POST /api/commands — submit a command request through the gateway.
 * The gateway enforces identity, workspace, permissions, risk, passport and
 * execution policy server-side. The client cannot choose risk, permissions,
 * approval policy, adapter or capability identity.
 */
export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = ExecuteSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid command request", 400);
  const body = parsed.data;

  try {
    const outcome = await services.gateway.submit(
      {
        commandId: body.commandId,
        version: body.version,
        workspaceId: body.workspaceId,
        args: body.args,
        targetType: body.targetType,
        targetId: body.targetId,
        idempotencyKey: body.idempotencyKey,
        agentId: body.agentId ?? null,
      },
      { userId: auth.userId, workspaceId: body.workspaceId },
    );
    return json(outcome, { status: outcome.status === "BLOCKED" ? 403 : 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Command rejected";
    return error(msg, /denied|not found|unknown|invalid/i.test(msg) ? 403 : 400);
  }
}
