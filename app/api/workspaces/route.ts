import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";
import { WORKSPACE_KINDS, type WorkspaceKind } from "@/lib/security/types";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  kind: z.enum(WORKSPACE_KINDS as [string, ...string[]]),
  name: z.string().min(1).max(120),
});

/** GET /api/workspaces — list workspaces the user is a member of. */
export async function GET() {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();
  const workspaces = services.workspace.listForUser(auth.userId);
  return json({
    workspaces: workspaces.map((w) => ({
      id: w.id,
      kind: w.kind,
      name: w.name,
      role: services.permissions.roleForMembership(w.id, auth.userId),
    })),
  });
}

/** POST /api/workspaces — create a workspace (creator becomes OWNER). */
export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid workspace", 400);
  const { kind, name } = parsed.data;

  const workspace = services.workspace.createWorkspace(
    auth.userId,
    kind as WorkspaceKind,
    name,
  );
  return json({
    workspace: { id: workspace.id, kind: workspace.kind, name: workspace.name, role: "OWNER" },
  });
}
