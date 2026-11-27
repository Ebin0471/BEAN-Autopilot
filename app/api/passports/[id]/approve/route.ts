import { getServices } from "@/lib/security/container";
import { error, forbidden, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ApproveSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: z.string().max(500).optional(),
});

/** POST /api/passports/[id]/approve — approve or reject a pending passport. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = ApproveSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid approval", 400);

  const passport = services.passport.get(params.id);
  if (!passport) return forbidden(); // do not reveal existence of inaccessible resources

  // Approver authority is enforced inside the service (actions.approve + separation of duties).
  try {
    const updated = services.passport.approve(
      params.id,
      auth.userId,
      parsed.data.decision,
      parsed.data.comment,
    );
    return json({ passport: { id: updated.id, status: updated.status } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Approval denied";
    return error(msg, /denied|not permitted|not pending/i.test(msg) ? 403 : 400);
  }
}
