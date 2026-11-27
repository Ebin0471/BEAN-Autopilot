import { getServices } from "@/lib/security/container";
import { error, forbidden, json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** GET /api/commands/executions?workspaceId=... — list command execution records. */
export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);
  if (!services.policy.authorize(auth.userId, workspaceId, "workspace.read")) return forbidden();

  const executions = services.lifecycle.list(workspaceId, 50).map((e) => ({
    id: e.id,
    commandId: e.command_id,
    commandVersion: e.command_version,
    capabilityId: e.capability_id,
    passportId: e.passport_id,
    status: e.status,
    idempotencyKey: e.idempotency_key,
    errorCode: e.error_code,
    createdAt: e.created_at,
    completedAt: e.completed_at,
  }));
  return json({ executions });
}
