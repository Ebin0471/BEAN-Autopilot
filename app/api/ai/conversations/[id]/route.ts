import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const RenameSchema = z.object({
  title: z.string().min(1).max(200),
});

const SelectionSchema = z.object({
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  routingMode: z.enum(["AUTO", "MANUAL"]),
});

/**
 * GET /api/ai/conversations/[id] — fetch a conversation (enforced to the
 * authenticated user + workspace).
 * PATCH — rename or update model selection.
 * DELETE — delete under policy.
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

  const conversation = services.conversations.get(params.id, workspaceId, auth.userId);
  if (!conversation) return error("Conversation not found", 404);
  return json({ conversation });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);

  const body = await req.json().catch(() => ({}));
  const conversation = services.conversations.get(params.id, workspaceId, auth.userId);
  if (!conversation) return error("Conversation not found", 404);

  if (typeof body.title === "string") {
    const parsed = RenameSchema.safeParse({ title: body.title });
    if (!parsed.success) return error("Invalid title", 400);
    return json({ conversation: services.conversations.rename(params.id, workspaceId, auth.userId, parsed.data.title) });
  }

  const sel = SelectionSchema.safeParse(body);
  if (!sel.success) return error("Invalid selection", 400);
  return json({
    conversation: services.conversations.setSelection(params.id, workspaceId, auth.userId, sel.data),
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);

  const conversation = services.conversations.get(params.id, workspaceId, auth.userId);
  if (!conversation) return error("Conversation not found", 404);

  services.conversations.delete(params.id, workspaceId, auth.userId);
  return json({ deleted: true });
}
