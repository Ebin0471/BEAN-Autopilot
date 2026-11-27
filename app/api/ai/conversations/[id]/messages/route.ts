import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/conversations/[id]/messages?workspaceId= — list a conversation's
 * messages, enforced to the authenticated user + workspace.
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);

  try {
    const messages = services.conversations.listMessages(params.id, workspaceId, auth.userId);
    return json({ messages });
  } catch {
    return error("Conversation not found", 404);
  }
}
