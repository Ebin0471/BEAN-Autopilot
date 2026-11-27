import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import type {
  AIProviderAdapter,
  ProviderAvailability,
  ProviderHealth,
  ProviderMetadata,
  ProviderHealthResult,
} from "./types";

/**
 * Provider Registry.
 *
 * Typed, versioned registration of AI providers. A provider definition records
 * its adapter type, endpoint/authentication *references* (never secrets),
 * supported modalities, capabilities, privacy classification and availability
 * state. Provider secrets are never stored in ordinary records and never
 * returned to the browser.
 *
 * Registering a provider does NOT make it available: availability is derived
 * from configuration and health, never from the registration alone.
 */
export class ProviderRegistry {
  private adapters = new Map<string, AIProviderAdapter>();

  constructor(private db: Db) {}

  /** Register (or update) a provider definition and its adapter. */
  register(
    meta: ProviderMetadata,
    adapter: AIProviderAdapter,
  ): ProviderMetadata {
    this.adapters.set(meta.providerId, adapter);
    const ts = now();
    const existing = this.get(meta.providerId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE ai_providers
           SET provider_name = ?, version = ?, adapter_type = ?, endpoint_ref = ?, auth_ref = ?,
               supported_modalities = ?, streaming_supported = ?, structured_output_supported = ?,
               tool_call_supported = ?, context_window = ?, rate_limit_json = ?, privacy_class = ?,
               availability_status = ?, health_status = ?, updated_at = ?
           WHERE provider_id = ?`,
        )
        .run(
          meta.providerName,
          meta.version,
          meta.adapterType,
          meta.endpointRef,
          meta.authRef,
          JSON.stringify(meta.supportedModalities),
          meta.streamingSupported ? 1 : 0,
          meta.structuredOutputSupported ? 1 : 0,
          meta.toolCallSupported ? 1 : 0,
          meta.contextWindow,
          meta.rateLimit ? JSON.stringify(meta.rateLimit) : null,
          meta.privacyClass,
          meta.availabilityStatus,
          meta.healthStatus,
          ts,
          meta.providerId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO ai_providers
           (id, provider_id, provider_name, version, adapter_type, endpoint_ref, auth_ref,
            supported_modalities, streaming_supported, structured_output_supported, tool_call_supported,
            context_window, rate_limit_json, privacy_class, availability_status, health_status,
            created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          uuid(),
          meta.providerId,
          meta.providerName,
          meta.version,
          meta.adapterType,
          meta.endpointRef,
          meta.authRef,
          JSON.stringify(meta.supportedModalities),
          meta.streamingSupported ? 1 : 0,
          meta.structuredOutputSupported ? 1 : 0,
          meta.toolCallSupported ? 1 : 0,
          meta.contextWindow,
          meta.rateLimit ? JSON.stringify(meta.rateLimit) : null,
          meta.privacyClass,
          meta.availabilityStatus,
          meta.healthStatus,
          ts,
          ts,
        );
    }
    return meta;
  }

  /** Resolve the live adapter for a provider (null when not registered). */
  adapterFor(providerId: string): AIProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  get(providerId: string): ProviderMetadata | null {
    const row = this.db
      .prepare("SELECT * FROM ai_providers WHERE provider_id = ?")
      .get(providerId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(): ProviderMetadata[] {
    const rows = this.db
      .prepare("SELECT * FROM ai_providers ORDER BY provider_name")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** True when a provider is configured AND healthy enough to serve requests. */
  isAvailable(providerId: string): boolean {
    const meta = this.get(providerId);
    if (!meta) return false;
    if (meta.availabilityStatus !== "AVAILABLE" && meta.availabilityStatus !== "DEGRADED") {
      return false;
    }
    if (meta.healthStatus === "UNAVAILABLE" || meta.healthStatus === "FAILING") {
      return false;
    }
    return true;
  }

  /** Update availability/health after a health check or configuration change. */
  setStatus(
    providerId: string,
    availability: ProviderAvailability,
    health: ProviderHealth,
  ): void {
    this.db
      .prepare(
        "UPDATE ai_providers SET availability_status = ?, health_status = ?, updated_at = ? WHERE provider_id = ?",
      )
      .run(availability, health, now(), providerId);
  }

  /** Run a health check through the provider's adapter and persist the result. */
  async healthCheck(providerId: string): Promise<ProviderHealthResult> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      const result: ProviderHealthResult = {
        providerId,
        healthy: false,
        health: "UNAVAILABLE",
        latencyMs: null,
        message: "No adapter registered for provider",
        checkedAt: now(),
      };
      this.setStatus(providerId, "UNAVAILABLE", "UNAVAILABLE");
      return result;
    }
    try {
      const result = await adapter.healthCheck();
      this.setStatus(
        providerId,
        result.healthy ? "AVAILABLE" : "DEGRADED",
        result.health,
      );
      return result;
    } catch (e) {
      const result: ProviderHealthResult = {
        providerId,
        healthy: false,
        health: "FAILING",
        latencyMs: null,
        message: e instanceof Error ? e.message : "Health check failed",
        checkedAt: now(),
      };
      this.setStatus(providerId, "DEGRADED", "FAILING");
      return result;
    }
  }

  private mapRow(row: Record<string, unknown>): ProviderMetadata {
    return {
      providerId: row.provider_id as string,
      providerName: row.provider_name as string,
      version: row.version as string,
      adapterType: row.adapter_type as ProviderMetadata["adapterType"],
      endpointRef: (row.endpoint_ref as string) ?? null,
      authRef: (row.auth_ref as string) ?? null,
      supportedModalities: JSON.parse((row.supported_modalities as string) || "[]"),
      streamingSupported: (row.streaming_supported as number) === 1,
      structuredOutputSupported: (row.structured_output_supported as number) === 1,
      toolCallSupported: (row.tool_call_supported as number) === 1,
      contextWindow: (row.context_window as number) ?? null,
      rateLimit: row.rate_limit_json ? JSON.parse(row.rate_limit_json as string) : null,
      privacyClass: row.privacy_class as ProviderMetadata["privacyClass"],
      availabilityStatus: row.availability_status as ProviderAvailability,
      healthStatus: row.health_status as ProviderHealth,
    };
  }
}
