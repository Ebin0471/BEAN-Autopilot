import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";
import {
  getConsent,
  setConsent,
  CONSENT_VERSION,
  type WorkspaceAiConsent,
} from "@/lib/ai/consent";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/consent?workspaceId=... — read the workspace's external-AI
 * consent state (authorised workspace-scoped). Returns the consent record plus
 * the list of EXTERNAL providers available to choose from, so the Settings UI
 * can render an explicit provider allowlist. No credentials or endpoint values
 * are exposed.
 *
 * PATCH /api/ai/consent?workspaceId=... — grant, update or revoke consent.
 * The workspace_id is resolved server-side from the session and verified
 * against membership; the client cannot set consent for a workspace it does
 * not belong to. Every change is recorded in the CORE-01 hash-chained
 * AuditService. Fail-closed: a PATCH that disables consent records a revoke.
 */

const PatchSchema = z.object({
  externalAiAllowed: z.boolean(),
  allowedExternalProviderIds: z.array(z.string().min(1)).optional(),
});

function publicConsent(c: WorkspaceAiConsent) {
  return {
    workspaceId: c.workspaceId,
    externalAiAllowed: c.externalAiAllowed,
    allowedExternalProviderIds: c.allowedExternalProviderIds,
    consentVersion: c.consentVersion,
    consentedBy: c.consentedBy,
    consentedAt: c.consentedAt,
    updatedAt: c.updatedAt,
  };
}

/** External providers the user may explicitly allow. */
function externalProviderOptions(services: ReturnType<typeof getServices>) {
  return services.aiProviders
    .list()
    .filter((p) => p.privacyClass === "EXTERNAL")
    .map((p) => ({
      providerId: p.providerId,
      providerName: p.providerName,
      adapterType: p.adapterType,
    }));
}

export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);

  try {
    services.policy.requireMember(auth.userId, workspaceId);
  } catch {
    return error("Forbidden", 403);
  }

  const consent = getConsent(services.db, workspaceId);
  return json({
    consent: publicConsent(consent),
    consentVersion: CONSENT_VERSION,
    providers: externalProviderOptions(services),
  });
}

export async function PATCH(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return error("workspaceId is required", 400);

  try {
    services.policy.requireMember(auth.userId, workspaceId);
  } catch {
    services.audit.append({
      workspaceId,
      actorId: auth.userId,
      actorType: "USER",
      eventType: "AI_CONSENT_UPDATE",
      targetType: "workspace_ai_consent",
      targetId: workspaceId,
      result: "DENIED",
      metadata: { reason: "not_a_member" },
    });
    return error("Forbidden", 403);
  }

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid consent request", 400);
  const body = parsed.data;

  // Validate that any requested provider id is a known external provider.
  const knownExternal = new Set(
    services.aiProviders.list().filter((p) => p.privacyClass === "EXTERNAL").map((p) => p.providerId),
  );
  const requested = body.allowedExternalProviderIds ?? [];
  const invalid = requested.filter((id) => !knownExternal.has(id));
  if (invalid.length > 0) {
    return error(`Unknown external provider ids: ${invalid.join(", ")}`, 400);
  }

  const consent = setConsent(services.db, workspaceId, {
    externalAiAllowed: body.externalAiAllowed,
    allowedExternalProviderIds: requested,
    consentedBy: auth.userId,
  });

  // CORE-01 audit record: hash-chained, tamper-evident, never stores secrets.
  services.audit.append({
    workspaceId,
    actorId: auth.userId,
    actorType: "USER",
    eventType: "AI_CONSENT_UPDATE",
    targetType: "workspace_ai_consent",
    targetId: workspaceId,
    result: body.externalAiAllowed ? "SUCCESS" : "DENIED",
    metadata: {
      externalAiAllowed: body.externalAiAllowed,
      allowedExternalProviderIds: requested,
      consentVersion: CONSENT_VERSION,
    },
  });

  return json({ consent: publicConsent(consent) });
}
