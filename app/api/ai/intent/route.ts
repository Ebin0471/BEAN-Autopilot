import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const IntentSchema = z.object({
  workspaceId: z.string().min(1),
  message: z.string().min(1).max(8000),
  preferredModelId: z.string().optional(),
});

/**
 * POST /api/ai/intent — recognise a structured intent from a request (no
 * execution). Enforces workspace membership. Returns the validated intent or
 * an honest error when no model is configured.
 */
export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = IntentSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid intent request", 400);
  const body = parsed.data;

  try {
    services.policy.requireMember(auth.userId, body.workspaceId);
  } catch {
    return error("Forbidden", 403);
  }

  try {
    const intent = await services.intent.recognise({
      requestText: body.message,
      workspaceId: body.workspaceId,
      preferredModelId: body.preferredModelId,
    });
    return json({ intent });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "INTENT_ERROR";
    const status = code === "NO_MODEL_AVAILABLE" || code === "NO_PROVIDER_ADAPTER" ? 503 : 400;
    return error(e instanceof Error ? e.message : "Intent recognition failed", status);
  }
}
