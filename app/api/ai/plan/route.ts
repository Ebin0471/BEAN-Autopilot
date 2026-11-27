import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PlanSchema = z.object({
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  message: z.string().min(1).max(8000),
});

/**
 * POST /api/ai/plan — propose a structured plan for a request (no execution).
 * The planner validates candidate commands against the registry and computes
 * permission/risk requirements server-side. Returns an inspectable proposed
 * plan; consequential tasks are flagged for human approval.
 */
export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = PlanSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid plan request", 400);
  const body = parsed.data;

  try {
    services.policy.requireMember(auth.userId, body.workspaceId);
  } catch {
    return error("Forbidden", 403);
  }

  const conversation = services.conversations.get(
    body.conversationId,
    body.workspaceId,
    auth.userId,
  );
  if (!conversation) return error("Conversation not found", 404);

  try {
    const intent = await services.intent.recognise({
      requestText: body.message,
      workspaceId: body.workspaceId,
    });
    const plan = await services.planner.propose({
      intent,
      workspaceId: body.workspaceId,
      userId: auth.userId,
      conversationId: body.conversationId,
    });
    return json({ intent, plan });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "PLANNING_ERROR";
    const status =
      code === "NO_MODEL_AVAILABLE" || code === "NO_PROVIDER_ADAPTER" ? 503 : 400;
    return error(e instanceof Error ? e.message : "Planning failed", status);
  }
}
