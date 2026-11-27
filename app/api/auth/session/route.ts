import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, SESSION_COOKIE, unauthorized } from "@/lib/api/http";
import { z } from "zod";

const SignInSchema = z.object({
  provider: z.string().min(1),
  providerUserId: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  displayName: z.string().min(1).optional(),
});

export const dynamic = "force-dynamic";

/** GET /api/auth/session — current identity and server-authorised workspaces. */
export async function GET() {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const user = services.identity.getUser(auth.userId);
  if (!user || user.status !== "ACTIVE") return unauthorized();
  const workspaces = services.workspace.listForUser(auth.userId);
  return json({
    user: { id: user.id, email: user.email, displayName: user.display_name, status: user.status },
    workspaces: workspaces.map((w) => ({ id: w.id, kind: w.kind, name: w.name })),
  });
}

/**
 * POST /api/auth/session — sign in.
 * Production authentication is CLOSED by default. A provider-neutral identity
 * layer is in place; real OIDC configuration arrives in a later milestone.
 * Dev/test sign-in is enabled ONLY when BEAN_DEV_AUTH_ENABLED=true.
 */
export async function POST(req: Request) {
  const services = getServices();

  if (process.env.BEAN_DEV_AUTH_ENABLED !== "true") {
    return error("Authentication is not configured", 503);
  }

  const parsed = SignInSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid sign-in request", 400);
  const { provider, providerUserId, email, displayName } = parsed.data;

  const { user, created } = services.identity.linkAuthAccount(provider, providerUserId, {
    email: email || null,
    displayName: displayName ?? null,
  });

  // First-time users receive a private Personal workspace.
  if (created && services.workspace.listForUser(user.id).length === 0) {
    services.workspace.createPersonalWorkspace(user.id);
  }

  const session = services.session.createSession(user.id, "web");
  services.audit.append({
    workspaceId: user.id,
    actorId: user.id,
    actorType: "USER",
    eventType: "LOGIN",
    result: "SUCCESS",
    metadata: { provider },
  });

  const response = json({
    user: { id: user.id, email: user.email, displayName: user.display_name },
    expiresAt: session.expiresAt,
  });
  response.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 3600,
  });
  return response;
}
