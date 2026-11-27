import { getServices } from "@/lib/security/container";
import { error, forbidden, json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** GET /api/audit?workspaceId=... — workspace-scoped audit events. */
export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);
  if (!services.policy.authorize(auth.userId, workspaceId, "audit.read")) return forbidden();

  const events = services.audit.list(workspaceId, 100);
  return json({
    events: events.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      actorId: e.actor_id,
      targetType: e.target_type,
      targetId: e.target_id,
      result: e.result,
      createdAt: e.created_at,
    })),
    integrity: services.audit.verifyChain(),
  });
}
