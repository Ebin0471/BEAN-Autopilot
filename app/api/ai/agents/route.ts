import { getServices } from "@/lib/security/container";
import { json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/agents — list registered agents (runtime registry foundation).
 * Enforces authentication. Returns only the registered runtime agents — the
 * 117-agent workforce archive (DOC-02) remains incomplete and is not fabricated.
 */
export async function GET() {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const agents = services.agents.list().map((a) => ({
    agentId: a.agentId,
    name: a.name,
    version: a.version,
    description: a.description,
    category: a.category,
    supportedWorkspaceTypes: a.supportedWorkspaceTypes,
    allowedCommandIds: a.allowedCommandIds,
    requiredPermissions: a.requiredPermissions,
    requiredCapabilities: a.requiredCapabilities,
    riskConstraints: a.riskConstraints,
    delegationPolicy: a.delegationPolicy,
    maximumSteps: a.maximumSteps,
    status: a.status,
  }));

  return json({ agents });
}
