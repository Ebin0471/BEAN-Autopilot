import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { Services } from "@/lib/security/container";
import type { Session } from "@/lib/security/session";

export const SESSION_COOKIE = "bean_session";

/** Extract and verify the session cookie. Returns null when absent/invalid/expired/revoked. */
export function getSession(services: Services): Session | null {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return services.session.verify(token);
}

export interface AuthContext {
  userId: string;
  sessionId: string;
}

/** Require an authenticated session. Returns null when unauthenticated. */
export function requireAuth(services: Services): AuthContext | null {
  const session = getSession(services);
  if (!session) return null;
  services.session.touch(session.id);
  return { userId: session.user_id, sessionId: session.id };
}

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/** Uniform error response. Does not reveal whether private resources exist. */
export function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function unauthorized() {
  return error("Authentication required", 401);
}

export function forbidden() {
  return error("Forbidden", 403);
}
