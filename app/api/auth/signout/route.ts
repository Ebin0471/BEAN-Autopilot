import { getServices } from "@/lib/security/container";
import { cookies } from "next/headers";
import { json, SESSION_COOKIE } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** POST /api/auth/signout — revoke the current session and clear the cookie. */
export async function POST() {
  const services = getServices();
  const token = cookies().get(SESSION_COOKIE)?.value;
  const revoked = services.session.revoke(token);
  if (revoked && token) {
    const session = services.session.verify(token);
    if (session) {
      services.audit.append({
        workspaceId: session.user_id,
        actorId: session.user_id,
        actorType: "USER",
        eventType: "LOGOUT",
        result: "SUCCESS",
      });
    }
  }
  const response = json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
