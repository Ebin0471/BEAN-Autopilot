import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import type { ModelMetadata, ModelStatus, StructuredOutputMode, TaskCategory } from "./types";

/**
 * Model Registry.
 *
 * Typed, versioned registration of AI models, each belonging to a provider.
 * A model records its supported tasks, modalities, context/output limits,
 * capability flags, privacy classification and status.
 *
 * Distinguish REGISTERED from AVAILABLE: a model is only AVAILABLE when its
 * provider is configured and healthy. Capabilities, prices and benchmarks are
 * never invented — only what the provider adapter reports is recorded.
 */
export class ModelRegistry {
  constructor(private db: Db) {}

  register(model: ModelMetadata): ModelMetadata {
    const ts = now();
    const existing = this.get(model.modelId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE ai_models
           SET provider_id = ?, model_name = ?, model_version = ?, supported_tasks = ?,
               supported_modalities = ?, max_context_tokens = ?, max_output_tokens = ?,
               structured_output = ?, structured_output_mode = ?, tool_call = ?, streaming = ?, reasoning = ?,
               latency_metadata = ?, cost_metadata = ?, privacy_class = ?, status = ?,
               availability_evidence = ?, updated_at = ?
           WHERE model_id = ?`,
        )
        .run(
          model.providerId,
          model.modelName,
          model.modelVersion,
          JSON.stringify(model.supportedTasks),
          JSON.stringify(model.supportedModalities),
          model.maxContextTokens,
          model.maxOutputTokens,
          model.structuredOutput ? 1 : 0,
          model.structuredOutputMode,
          model.toolCall ? 1 : 0,
          model.streaming ? 1 : 0,
          model.reasoning ? 1 : 0,
          model.latencyMetadata ? JSON.stringify(model.latencyMetadata) : null,
          model.costMetadata ? JSON.stringify(model.costMetadata) : null,
          model.privacyClass,
          model.status,
          model.availabilityEvidence,
          ts,
          model.modelId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO ai_models
           (id, model_id, provider_id, model_name, model_version, supported_tasks, supported_modalities,
            max_context_tokens, max_output_tokens, structured_output, structured_output_mode, tool_call, streaming, reasoning,
            latency_metadata, cost_metadata, privacy_class, status, availability_evidence, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          uuid(),
          model.modelId,
          model.providerId,
          model.modelName,
          model.modelVersion,
          JSON.stringify(model.supportedTasks),
          JSON.stringify(model.supportedModalities),
          model.maxContextTokens,
          model.maxOutputTokens,
          model.structuredOutput ? 1 : 0,
          model.structuredOutputMode,
          model.toolCall ? 1 : 0,
          model.streaming ? 1 : 0,
          model.reasoning ? 1 : 0,
          model.latencyMetadata ? JSON.stringify(model.latencyMetadata) : null,
          model.costMetadata ? JSON.stringify(model.costMetadata) : null,
          model.privacyClass,
          model.status,
          model.availabilityEvidence,
          ts,
          ts,
        );
    }
    return model;
  }

  get(modelId: string): ModelMetadata | null {
    const row = this.db
      .prepare("SELECT * FROM ai_models WHERE model_id = ?")
      .get(modelId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(providerId?: string): ModelMetadata[] {
    const rows = (
      providerId
        ? this.db
            .prepare("SELECT * FROM ai_models WHERE provider_id = ? ORDER BY model_name")
            .all(providerId)
        : this.db.prepare("SELECT * FROM ai_models ORDER BY provider_id, model_name").all()
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Models that are actually usable: REGISTERED/AVAILABLE and not disabled,
   * for a given task category. Availability is provider-derived, never assumed.
   */
  listAvailableForTask(task: TaskCategory, providerAvailability: (providerId: string) => boolean): ModelMetadata[] {
    return this.list().filter(
      (m) =>
        m.status !== "DISABLED" &&
        m.supportedTasks.includes(task) &&
        providerAvailability(m.providerId),
    );
  }

  setStatus(modelId: string, status: ModelStatus): void {
    this.db
      .prepare("UPDATE ai_models SET status = ?, updated_at = ? WHERE model_id = ?")
      .run(status, now(), modelId);
  }

  private mapRow(row: Record<string, unknown>): ModelMetadata {
    return {
      modelId: row.model_id as string,
      providerId: row.provider_id as string,
      modelName: row.model_name as string,
      modelVersion: row.model_version as string,
      supportedTasks: JSON.parse((row.supported_tasks as string) || "[]"),
      supportedModalities: JSON.parse((row.supported_modalities as string) || "[]"),
      maxContextTokens: (row.max_context_tokens as number) ?? null,
      maxOutputTokens: (row.max_output_tokens as number) ?? null,
      structuredOutput: (row.structured_output as number) === 1,
      structuredOutputMode: ((row.structured_output_mode as string) ?? "NONE") as StructuredOutputMode,
      toolCall: (row.tool_call as number) === 1,
      streaming: (row.streaming as number) === 1,
      reasoning: (row.reasoning as number) === 1,
      latencyMetadata: row.latency_metadata ? JSON.parse(row.latency_metadata as string) : null,
      costMetadata: row.cost_metadata ? JSON.parse(row.cost_metadata as string) : null,
      privacyClass: row.privacy_class as ModelMetadata["privacyClass"],
      status: row.status as ModelStatus,
      availabilityEvidence: (row.availability_evidence as string) ?? null,
    };
  }
}
