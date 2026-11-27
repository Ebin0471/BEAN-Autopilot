import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1).max(200),
  selectedModelId: z.string().nullable().optional(),
  selectedProviderId: z.string().nullable().optional(),
  routingMode: z.enum(["AUTO", "MANUAL"]).optional(),
});

/**
 * GET /api/ai/conversations?workspaceId= — list a user's conversations in a
 * workspace (enforced to the authenticated user + workspace).
 * POST /api/ai/conversations — create a conversation.
 */
export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);

  // Workspace membership is enforced by the policy engine (deny-by-default).
  try {
    services.policy.requireMember(auth.userId, workspaceId);
  } catch {
    return error("Forbidden", 403);
  }

  const conversations = services.conversations.list(workspaceId, auth.userId);
  return json({ conversations });
}

export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid conversation request", 400);
  const body = parsed.data;

  try {
    services.policy.requireMember(auth.userId, body.workspaceId);
  } catch {
    return error("Forbidden", 403);
  }

  const conversation = services.conversations.create({
    workspaceId: body.workspaceId,
    userId: auth.userId,
    title: body.title,
    selectedModelId: body.selectedModelId ?? null,
    selectedProviderId: body.selectedProviderId ?? null,
    routingMode: body.routingMode ?? "AUTO",
  });
  return json({ conversation }, { status: 201 });
}
