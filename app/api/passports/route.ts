import { getServices } from "@/lib/security/container";
import { error, forbidden, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";
import { PERMISSIONS, type ActionRequest, type Permission } from "@/lib/security/types";
import type { Passport } from "@/lib/security/passport";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  workspaceId: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  command: z.string().min(1),
  operation: z.string().min(1),
  dataScope: z.string().min(1),
  permissionScope: z.array(z.string()).min(1),
  approvalPolicy: z.enum(["NONE", "SINGLE", "DUAL"]).default("SINGLE"),
  verificationRequirements: z.array(z.string()).default([]),
  idempotencyKey: z.string().min(1),
  riskClass: z.enum(["R0", "R1", "R2", "R3", "R4"]).optional(),
});

function toPassportView(p: Passport) {
  return {
    id: p.id,
    workspaceId: p.workspace_id,
    command: p.command,
    operation: p.operation,
    targetType: p.target_type,
    targetId: p.target_id,
    riskClass: p.risk_class,
    status: p.status,
    approvalPolicy: p.approval_policy,
    expiresAt: p.expires_at,
    createdAt: p.created_at,
  };
}

/** GET /api/passports?workspaceId=... — list passports for a workspace. */
export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);
  if (!services.policy.authorize(auth.userId, workspaceId, "workspace.read")) return forbidden();

  return json({ passports: services.passport.list(workspaceId).map(toPassportView) });
}

/** POST /api/passports — create an action request (server-issued passport). */
export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid action request", 400);
  const body = parsed.data;

  // Unknown permissions in the requested scope are rejected outright.
  const scope = body.permissionScope.filter((p) => (PERMISSIONS as string[]).includes(p)) as Permission[];
  if (scope.length !== body.permissionScope.length) {
    return error("Unknown permission in scope", 400);
  }

  const action: ActionRequest = {
    workspaceId: body.workspaceId,
    targetType: body.targetType,
    targetId: body.targetId,
    command: body.command,
    operation: body.operation,
    dataScope: body.dataScope,
    permissionScope: scope,
    riskClass: (body.riskClass ?? "R2") as ActionRequest["riskClass"],
    paramHash: "", // computed server-side
    idempotencyKey: body.idempotencyKey,
    approvalPolicy: body.approvalPolicy,
    verificationRequirements: body.verificationRequirements,
  };

  try {
    const { passport, created } = services.passport.createRequest(
      { userId: auth.userId, workspaceId: body.workspaceId },
      action,
    );
    return json({ passport: toPassportView(passport), created }, { status: created ? 201 : 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Request denied";
    const status = /denied|not held|Owner role/i.test(msg) ? 403 : 400;
    return error(msg, status);
  }
}
