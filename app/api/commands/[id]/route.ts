import { getServices } from "@/lib/security/container";
import { error, json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** GET /api/commands/[id]?version=... — describe a registered command. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const version = new URL(req.url).searchParams.get("version") ?? undefined;
  let def;
  try {
    def = services.commands.assertSupported(params.id, version);
  } catch {
    return error("Command not found", 404);
  }
  return json({
    command: {
      commandId: def.commandId,
      version: def.version,
      name: def.name,
      description: def.description,
      category: def.category,
      requiredCapability: def.requiredCapability,
      requiredPermissions: def.requiredPermissions,
      serverRiskClass: def.serverRiskClass,
      approvalPolicy: def.approvalPolicy,
      executionMode: def.executionMode,
      verificationContract: def.verificationContract,
      compensationContract: def.compensationContract,
      deprecationStatus: def.deprecationStatus,
      documentation: def.documentation,
    },
  });
}
