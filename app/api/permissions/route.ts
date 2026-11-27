import { getServices } from "@/lib/security/container";
import { error, forbidden, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({ workspaceId: z.string().min(1) });

/** GET /api/permissions?workspaceId=... — effective role and permissions (server-resolved). */
export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return error("workspaceId is required", 400);
  const { workspaceId } = parsed.data;

  // Membership + permission check (deny-by-default). Unknown/unjoined workspace => 403.
  const ctx = services.policy.resolve(auth.userId, workspaceId);
  if (!ctx) return forbidden();

  return json({
    workspaceId,
    role: ctx.role,
    permissions: ctx.permissions,
  });
}
