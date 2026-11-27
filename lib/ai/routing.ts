import type {
  ModelMetadata,
  ProviderMetadata,
  RoutingConstraints,
  RoutingDecision,
  TaskCategory,
} from "./types";
import type { ProviderRegistry } from "./provider-registry";
import type { ModelRegistry } from "./model-registry";

export class RoutingError extends Error {
  constructor(message: string, public code = "ROUTING_ERROR") {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Model Routing Engine.
 *
 * Chooses an appropriate model for a task based on the user's preference, the
 * task category, required capabilities, context length, modality, privacy
 * classification, workspace policy, provider availability, health, latency and
 * budget. Routing never selects an unavailable provider, never routes a task
 * to a model lacking required capabilities, never silently sends private data
 * to a different provider, and never silently switches to a more expensive
 * route. Fallbacks respect data classification and are visible in the decision.
 */
export class ModelRouter {
  constructor(
    private providers: ProviderRegistry,
    private models: ModelRegistry,
  ) {}

  /**
   * Select a model for the given constraints. Throws RoutingError when no
   * model satisfies the constraints (honest "not configured / unavailable"
   * rather than silently returning a wrong model).
   */
  route(constraints: RoutingConstraints): RoutingDecision {
    const candidates = this.models.list().filter((m) => {
      if (m.status === "DISABLED") return false;
      // Required task category.
      if (!m.supportedTasks.includes(constraints.taskCategory)) return false;
      // Required modalities.
      for (const mod of constraints.requiredModalities) {
        if (!m.supportedModalities.includes(mod)) return false;
      }
      // Required capabilities.
      if (constraints.requireStructuredOutput && !m.structuredOutput) return false;
      if (constraints.requireToolCall && !m.toolCall) return false;
      if (constraints.requireReasoning && !m.reasoning) return false;
      // Context window.
      if (
        constraints.maxContextTokens &&
        m.maxContextTokens != null &&
        m.maxContextTokens < constraints.maxContextTokens
      ) {
        return false;
      }
      // Output token budget.
      if (
        constraints.budgetLimitTokens &&
        m.maxOutputTokens != null &&
        m.maxOutputTokens > constraints.budgetLimitTokens
      ) {
        return false;
      }
      return true;
    });

    // Provider availability + privacy filter.
    const viable = candidates.filter((m) => {
      const provider = this.providers.get(m.providerId);
      if (!provider) return false;
      // Production restriction: the deterministic test provider never serves
      // production traffic. It exists to exercise the pipeline out of the box
      // in non-production environments only.
      if (isProduction() && provider.adapterType === "test") return false;
      if (!this.providers.isAvailable(m.providerId)) return false;
      // Never route private data to a provider of a lower privacy class.
      if (
        constraints.privacyClass &&
        rankPrivacy(m.privacyClass) < rankPrivacy(constraints.privacyClass)
      ) {
        return false;
      }
      return true;
    });

    if (viable.length === 0) {
      throw new RoutingError(
        `No available model satisfies the task "${constraints.taskCategory}" with the required capabilities. Configure a provider or adjust the constraints.`,
        "NO_MODEL_AVAILABLE",
      );
    }

    // Preference: explicit model id first, then reasoning models for
    // reasoning/planning tasks, then the first viable model.
    let chosen: ModelMetadata;
    let reason: string;
    if (constraints.preferredModelId) {
      const pref = viable.find((m) => m.modelId === constraints.preferredModelId);
      if (pref) {
        chosen = pref;
        reason = "User-selected model is available and satisfies the constraints.";
      } else {
        throw new RoutingError(
          `The selected model "${constraints.preferredModelId}" is not available for this task.`,
          "PREFERRED_MODEL_UNAVAILABLE",
        );
      }
    } else if (
      (constraints.taskCategory === "REASONING" ||
        constraints.taskCategory === "PLANNING" ||
        constraints.taskCategory === "WORKFLOW_DESIGN") &&
      viable.some((m) => m.reasoning)
    ) {
      chosen = viable.find((m) => m.reasoning)!;
      reason = `Routed to a reasoning-capable model for ${constraints.taskCategory}.`;
    } else {
      chosen = viable[0];
      reason = `Routed to the first available model satisfying ${constraints.taskCategory}.`;
    }

    const provider = this.providers.get(chosen.providerId)!;
    return {
      modelId: chosen.modelId,
      providerId: chosen.providerId,
      model: chosen,
      provider,
      reason,
      fallbackChain: [chosen.modelId],
      fallbackUsed: false,
    };
  }

  /**
   * Build the fallback chain for a task: ordered viable models, respecting
   * privacy. Used to plan controlled fallbacks when the primary model fails.
   */
  fallbackChain(constraints: RoutingConstraints): ModelMetadata[] {
    return this.models
      .list()
      .filter((m) => {
        if (m.status === "DISABLED") return false;
        if (!m.supportedTasks.includes(constraints.taskCategory)) return false;
        if (!this.providers.isAvailable(m.providerId)) return false;
        if (
          constraints.privacyClass &&
          rankPrivacy(m.privacyClass) < rankPrivacy(constraints.privacyClass)
        ) {
          return false;
        }
        return true;
      })
      .filter((m) => {
        if (constraints.requireStructuredOutput && !m.structuredOutput) return false;
        if (constraints.requireToolCall && !m.toolCall) return false;
        if (constraints.requireReasoning && !m.reasoning) return false;
        return true;
      });
  }
}

/** True when running in a production environment. */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Privacy rank: INTERNAL (highest trust) > LOCAL > EXTERNAL. */
function rankPrivacy(p: string): number {
  if (p === "INTERNAL") return 3;
  if (p === "LOCAL") return 2;
  return 1;
}

export type { TaskCategory, ProviderMetadata };
