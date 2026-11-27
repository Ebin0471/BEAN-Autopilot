import { getServices } from "@/lib/security/container";
import { error, forbidden, json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** POST /api/passports/[id]/revoke — revoke an unconsumed passport (owner only). */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const passport = services.passport.get(params.id);
  if (!passport) return forbidden();

  try {
    const updated = services.passport.revoke(params.id, auth.userId);
    return json({ passport: { id: updated.id, status: updated.status } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Revocation denied";
    return error(msg, /denied|Owner/i.test(msg) ? 403 : 400);
  }
}
