import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** GET /api/capabilities/[id]?version=... — describe a capability. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const version = new URL(req.url).searchParams.get("version") ?? undefined;
  const cap = services.capabilities.get(params.id, version);
  if (!cap) return error("Capability not found", 404);
  return json({
    capability: {
      capabilityId: cap.capabilityId,
      version: cap.version,
      name: cap.name,
      category: cap.category,
      provider: cap.provider,
      description: cap.description,
      supportedCommands: cap.supportedCommands,
      requiredScopes: cap.requiredScopes,
      supportedWorkspaceTypes: cap.supportedWorkspaceTypes,
      riskConstraints: cap.riskConstraints,
      availabilityStatus: cap.availabilityStatus,
      healthStatus: cap.healthStatus,
      trustLevel: cap.trustLevel,
      verificationSupport: cap.verificationSupport,
      compensationSupport: cap.compensationSupport,
      documentation: cap.documentation,
    },
  });
}
