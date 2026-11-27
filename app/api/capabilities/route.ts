import { getServices } from "@/lib/security/container";
import { json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** GET /api/capabilities?category=... — list registered capabilities (discovery). */
export async function GET(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const category = new URL(req.url).searchParams.get("category") ?? undefined;
  const capabilities = services.capabilities.list(category).map((c) => ({
    capabilityId: c.capabilityId,
    version: c.version,
    name: c.name,
    category: c.category,
    provider: c.provider,
    availabilityStatus: c.availabilityStatus,
    healthStatus: c.healthStatus,
    trustLevel: c.trustLevel,
    supportedCommands: c.supportedCommands,
    requiredScopes: c.requiredScopes,
  }));
  return json({ capabilities });
}
