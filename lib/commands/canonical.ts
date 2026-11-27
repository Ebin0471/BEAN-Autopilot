import { sha256 } from "@/lib/db/util";

/**
 * Deterministic canonicalisation and full-payload parameter binding.
 *
 * CORE-02 SECURITY FIX: the CORE-01 `computeParamHash` bound a passport only to
 * `command | targetType | targetId | dataScope` and omitted the complete command
 * argument payload. That meant an approval for one set of arguments also
 * authorised a different set with the same command/target (e.g.
 * `invoice.send(amount=1000, recipient=A)` also authorising
 * `invoice.send(amount=10000, recipient=B)`).
 *
 * This module provides a deterministic canonical representation covering the
 * FULL binding: workspace, command id + version, capability id + version,
 * target type/id, the complete validated command arguments, and execution
 * options. The same canonical payload is used for hash creation, passport
 * request, approval display, execution and verification.
 */

/** Keys whose values must never be bound into a passport (credential handles). */
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|otp|private[_-]?key|credential|session)/i;

export class CanonicalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalisationError";
  }
}

/**
 * Produce a deterministic JSON string for arbitrary validated data.
 * - Object keys are sorted recursively (stable ordering).
 * - Array order is preserved (meaningful ordering).
 * - Rejects unsupported types, `undefined`, `NaN`, `Infinity`, and functions.
 * - Sensitive keys are replaced with a marker so secrets never enter a hash.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) {
    throw new CanonicalisationError("Cannot canonicalise undefined");
  }
  const t = typeof value;
  if (t === "string") return value;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalisationError("Cannot canonicalise non-finite number");
    }
    return value;
  }
  if (t === "boolean") return value;
  if (t === "bigint") return `${value}n`;
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Deterministic key ordering.
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) {
        throw new CanonicalisationError("Cannot canonicalise undefined property");
      }
      out[key] = SENSITIVE_KEY.test(key) ? "[CREDENTIAL_HANDLE]" : canonicalizeValue(v);
    }
    return out;
  }
  throw new CanonicalisationError(`Cannot canonicalise unsupported type: ${t}`);
}

/** The complete set of fields that bind a passport to an exact operation. */
export interface BindingFields {
  workspaceId: string;
  commandId: string;
  commandVersion: string;
  capabilityId?: string | null;
  capabilityVersion?: string | null;
  targetType: string;
  targetId: string;
  /** Complete validated command arguments. */
  args: Record<string, unknown>;
  /** Relevant execution options. */
  executionOptions?: Record<string, unknown>;
}

/** Build the canonical binding payload string (deterministic). */
export function canonicalBinding(b: BindingFields): string {
  return canonicalize({
    workspaceId: b.workspaceId,
    commandId: b.commandId,
    commandVersion: b.commandVersion,
    capabilityId: b.capabilityId ?? null,
    capabilityVersion: b.capabilityVersion ?? null,
    targetType: b.targetType,
    targetId: b.targetId,
    args: b.args ?? {},
    executionOptions: b.executionOptions ?? {},
  });
}

/** Cryptographic binding hash over the complete canonical payload. */
export function computeBindingHash(b: BindingFields): string {
  return sha256(canonicalBinding(b));
}

/**
 * Backward-compatible parameter hash for the CORE-01 ActionRequest shape.
 *
 * Preserves the original exported signature but now folds in the command
 * argument payload (`params`) when present, so existing callers that pass no
 * params still get a valid hash while new callers get full-payload binding.
 */
export function computeParamHash(action: {
  workspaceId: string;
  command: string;
  targetType: string;
  targetId: string;
  dataScope: string;
  params?: Record<string, unknown>;
}): string {
  return computeBindingHash({
    workspaceId: action.workspaceId,
    commandId: action.command,
    commandVersion: "1", // CORE-01 commands were unversioned
    targetType: action.targetType,
    targetId: action.targetId,
    args: action.params ?? {},
    executionOptions: { dataScope: action.dataScope },
  });
}
