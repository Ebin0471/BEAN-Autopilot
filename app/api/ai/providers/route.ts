import { getServices } from "@/lib/security/container";
import { json, requireAuth, unauthorized } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/providers — list registered AI providers and their models.
 * Enforces authentication; returns only non-secret metadata (no credentials,
 * no endpoint values). Distinguishes registered from available providers.
 */
export async function GET() {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const providers = services.aiProviders.list().map((p) => ({
    providerId: p.providerId,
    providerName: p.providerName,
    version: p.version,
    adapterType: p.adapterType,
    supportedModalities: p.supportedModalities,
    streamingSupported: p.streamingSupported,
    structuredOutputSupported: p.structuredOutputSupported,
    structuredOutputMode: p.structuredOutputMode,
    toolCallSupported: p.toolCallSupported,
    privacyClass: p.privacyClass,
    availabilityStatus: p.availabilityStatus,
    healthStatus: p.healthStatus,
    available: services.aiProviders.isAvailable(p.providerId),
  }));

  const models = services.aiModels.list().map((m) => ({
    modelId: m.modelId,
    providerId: m.providerId,
    modelName: m.modelName,
    modelVersion: m.modelVersion,
    supportedTasks: m.supportedTasks,
    supportedModalities: m.supportedModalities,
    maxContextTokens: m.maxContextTokens,
    maxOutputTokens: m.maxOutputTokens,
    structuredOutput: m.structuredOutput,
    structuredOutputMode: m.structuredOutputMode,
    toolCall: m.toolCall,
    streaming: m.streaming,
    reasoning: m.reasoning,
    privacyClass: m.privacyClass,
    status: m.status,
  }));

  return json({ providers, models });
}
