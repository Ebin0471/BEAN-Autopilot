import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Schema = z.object({
  commandId: z.string().min(1),
  version: z.string().optional(),
  workspaceId: z.string().min(1),
  args: z.record(z.unknown()),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  idempotencyKey: z.string().min(1),
});

/** POST /api/commands/preview — dry-run preview (no execution, no passport). */
export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid preview request", 400);
  const body = parsed.data;

  const plan = services.gateway.preview(
    {
      commandId: body.commandId,
      version: body.version,
      workspaceId: body.workspaceId,
      args: body.args,
      targetType: body.targetType,
      targetId: body.targetId,
      idempotencyKey: body.idempotencyKey,
    },
    { userId: auth.userId, workspaceId: body.workspaceId },
  );
  return json({
    commandId: plan.command.commandId,
    version: plan.command.version,
    capabilityId: plan.capabilityId,
    capabilityUsable: plan.capabilityUsable,
    permissionsOk: plan.permissionsOk,
    riskClass: plan.riskClass,
    approvalRequired: plan.approvalRequired,
    paramsHash: plan.paramsHash,
    errors: plan.errors,
  });
}
