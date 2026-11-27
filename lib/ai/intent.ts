import { z } from "zod";
import { now, uuid } from "@/lib/db/util";
import type { ProviderRegistry } from "./provider-registry";
import type { ModelRegistry } from "./model-registry";
import type { ModelRouter } from "./routing";
import type {
  Intent,
  IntentEntity,
  RoutingConstraints,
  SensitivityClassification,
  TaskCategory,
  PrivacyClass,
} from "./types";
import { ALL_TASK_CATEGORIES } from "./types";

export class IntentError extends Error {
  constructor(message: string, public code = "INTENT_ERROR") {
    super(message);
    this.name = "IntentError";
  }
}

/**
 * Strict runtime schema for the model's structured intent output. The model's
 * structured response is UNTRUSTED input; it is validated against this schema
 * before being accepted. Anything malformed is rejected, not coerced.
 */
const IntentEntitySchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const IntentSchema = z.object({
  taskCategory: z.enum(ALL_TASK_CATEGORIES as [string, ...string[]]),
  desiredOutcome: z.string().min(1),
  entities: z.array(IntentEntitySchema).default([]),
  constraints: z.array(z.string()).default([]),
  preferences: z.array(z.string()).default([]),
  deadlines: z.array(z.string()).default([]),
  amounts: z.array(z.string()).default([]),
  targets: z.array(z.string()).default([]),
  requestedActions: z.array(z.string()).default([]),
  requiredCapabilities: z.array(z.string()).default([]),
  sensitivityClassification: z.enum([
    "INTERNAL",
    "CONFIDENTIAL",
    "PERSONAL",
    "PUBLIC",
  ]),
  ambiguityList: z.array(z.string()).default([]),
  missingInformation: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  requiresClarification: z.boolean(),
});

/**
 * Intent Understanding Engine.
 *
 * Converts a user request into a structured, validated intent. Uses the model
 * router to select a capable model, asks for a structured intent, and validates
 * the (untrusted) model output against a strict runtime schema. Designed for
 * Tamil, Tanglish, English and code-switched input; ambiguous important values
 * (money, dates, names, recipients, quantities, identifiers) are surfaced for
 * confirmation.
 */
export class IntentEngine {
  constructor(
    private router: ModelRouter,
    private providers: ProviderRegistry,
    private models: ModelRegistry,
  ) {}

  /**
   * Recognise intent from request text. Throws IntentError when no model is
   * available or the model output is malformed (honest failure, no fabrication).
   */
  async recognise(input: {
    requestText: string;
    workspaceId: string;
    preferredModelId?: string;
    sensitivityClassification?: SensitivityClassification;
  }): Promise<Intent> {
    const constraints: RoutingConstraints = {
      taskCategory: "GENERAL_CHAT",
      requiredModalities: ["text"],
      requireStructuredOutput: true,
      requireToolCall: false,
      requireReasoning: false,
      privacyClass: sensitivityToPrivacy(input.sensitivityClassification ?? "INTERNAL"),
      preferredModelId: input.preferredModelId,
    };

    // Route to a model that supports structured output. If the router reports
    // no model available, surface an honest "not configured" error.
    const decision = this.router.route(constraints);
    const adapter = this.providers.adapterFor(decision.providerId);
    if (!adapter) {
      throw new IntentError(
        `No adapter available for provider ${decision.providerId}.`,
        "NO_PROVIDER_ADAPTER",
      );
    }

    const requestId = uuid();
    const response = await adapter.generate({
      requestId,
      modelId: decision.modelId,
      messages: [
        {
          role: "system",
          content:
            "You are BEAN Autopilot's intent classifier. Respond ONLY with a JSON object matching the intent schema. Classify the task category, extract entities, constraints, ambiguity and missing information. Be conservative: surface ambiguity for important values (money, dates, names, recipients, quantities, identifiers).",
        },
        { role: "user", content: input.requestText },
      ],
      taskCategory: "GENERAL_CHAT",
      responseSchema: { type: "object" },
    });

    if (response.error) {
      throw new IntentError(
        `Model failed to produce an intent: ${response.error.message}`,
        "MODEL_ERROR",
      );
    }
    if (!response.structured || typeof response.structured !== "object") {
      throw new IntentError(
        "Model did not return structured intent output.",
        "INVALID_INTENT_OUTPUT",
      );
    }

    // Validate the untrusted structured output against the strict schema.
    const parsed = IntentSchema.safeParse(response.structured);
    if (!parsed.success) {
      throw new IntentError(
        `Model intent output failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        "INVALID_INTENT_OUTPUT",
      );
    }

    const data = parsed.data;
    return {
      intentId: uuid(),
      requestText: input.requestText,
      language: detectLanguage(input.requestText),
      workspaceId: input.workspaceId,
      taskCategory: data.taskCategory as TaskCategory,
      desiredOutcome: data.desiredOutcome,
      entities: data.entities as IntentEntity[],
      constraints: data.constraints,
      preferences: data.preferences,
      deadlines: data.deadlines,
      amounts: data.amounts,
      targets: data.targets,
      requestedActions: data.requestedActions,
      requiredCapabilities: data.requiredCapabilities,
      sensitivityClassification: data.sensitivityClassification,
      ambiguityList: data.ambiguityList,
      missingInformation: data.missingInformation,
      confidence: data.confidence,
      requiresClarification: data.requiresClarification,
    };
  }

  /** Convenience: recognise intent and persist nothing (pure recognition). */
  async recogniseAt(requestText: string, workspaceId: string): Promise<Intent> {
    return this.recognise({ requestText, workspaceId });
  }
}

/**
 * Lightweight language detection for Tamil / Tanglish / English. This is a
 * heuristic for routing and display, not a full NLP classifier. Tamil Unicode
 * range detection + common Tanglish markers.
 */
function detectLanguage(text: string): string {
  const tamil = /[\u0B80-\u0BFF]/.test(text); // full Tamil Unicode block
  const tanglish = /(lor|pa,|paa|da|daa|poda|vendi|naan|nee|na|romba|sareya|kooda|ila|mattum|ethu|evan|aval|nga|la|laa)\b/i.test(text);
  if (tamil) return "tamil";
  if (tanglish) return "tanglish";
  return "english";
}

function sensitivityToPrivacy(s: SensitivityClassification): PrivacyClass {
  if (s === "PUBLIC") return "EXTERNAL";
  return "INTERNAL";
}

export { now };
