/**
 * CORE-03G — Workspace external-AI consent.
 *
 * A workspace must explicitly consent before any EXTERNAL privacy-class AI
 * provider is used. This is enforced server-side: the router consults this
 * module before routing to an external provider, and the chat route consults
 * it before initiating any external-AI request. Consent is stored in the
 * `workspace_ai_consent` table (additive migration) and is NEVER trusted from
 * the client — the workspace_id is resolved server-side from the session.
 *
 * Fail-closed: an absent or revoked consent means external AI is unavailable.
 * LOCAL and INTERNAL providers are not subject to external-AI consent (they do
 * not leave the trust boundary), but this module is the single place that
 * decides what "external AI allowed" means.
 */

import type { Db } from "@/lib/db/database";
import type { PrivacyClass } from "./types";

/** The consent schema version this implementation understands. */
export const CONSENT_VERSION = "1.0.0";

export interface WorkspaceAiConsent {
  workspaceId: string;
  externalAiAllowed: boolean;
  allowedExternalProviderIds: string[];
  consentVersion: string;
  consentedBy: string | null;
  consentedAt: string | null;
  updatedAt: string | null;
}

export type ConsentErrorCode =
  | "CONSENT_REQUIRED"
  | "PROVIDER_NOT_ALLOWED"
  | "CONSENT_REVOKED";

export class ConsentError extends Error {
  constructor(message: string, public code: ConsentErrorCode) {
    super(message);
    this.name = "ConsentError";
  }
}

/** Read the consent row for a workspace (creating a default row if absent). */
export function getConsent(db: Db, workspaceId: string): WorkspaceAiConsent {
  const row = db
    .prepare(`SELECT * FROM workspace_ai_consent WHERE workspace_id = ?`)
    .get(workspaceId) as Record<string, unknown> | undefined;

  if (!row) {
    // Absent row = not consented. Create a default (denied) row for clarity.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspace_ai_consent
         (workspace_id, external_ai_allowed, allowed_external_provider_ids,
          consent_version, consented_by, consented_at, updated_at, created_at)
       VALUES (?, 0, ?, ?, NULL, NULL, ?, ?)`,
    ).run(workspaceId, "[]", CONSENT_VERSION, now, now);
    return {
      workspaceId,
      externalAiAllowed: false,
      allowedExternalProviderIds: [],
      consentVersion: CONSENT_VERSION,
      consentedBy: null,
      consentedAt: null,
      updatedAt: now,
    };
  }

  return {
    workspaceId: String(row.workspace_id),
    externalAiAllowed: (row.external_ai_allowed as number) === 1,
    allowedExternalProviderIds: parseProviderList(row.allowed_external_provider_ids),
    consentVersion: String(row.consent_version ?? CONSENT_VERSION),
    consentedBy: row.consented_by ? String(row.consented_by) : null,
    consentedAt: row.consented_at ? String(row.consented_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

/** Grant (or update) consent for a workspace. */
export function setConsent(
  db: Db,
  workspaceId: string,
  options: {
    externalAiAllowed: boolean;
    allowedExternalProviderIds?: string[];
    consentedBy: string;
  },
): WorkspaceAiConsent {
  const now = new Date().toISOString();
  const providers = options.allowedExternalProviderIds ?? [];
  db.prepare(
    `INSERT INTO workspace_ai_consent
       (workspace_id, external_ai_allowed, allowed_external_provider_ids,
        consent_version, consented_by, consented_at, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       external_ai_allowed = excluded.external_ai_allowed,
       allowed_external_provider_ids = excluded.allowed_external_provider_ids,
       consent_version = excluded.consent_version,
       consented_by = excluded.consented_by,
       consented_at = excluded.consented_at,
       updated_at = excluded.updated_at`,
  ).run(
    workspaceId,
    options.externalAiAllowed ? 1 : 0,
    JSON.stringify(providers),
    CONSENT_VERSION,
    options.consentedBy,
    now,
    now,
    now,
  );
  return getConsent(db, workspaceId);
}

/**
 * Assert that a workspace may use the given provider privacy class.
 *
 * - INTERNAL / LOCAL: always permitted (no external-AI consent needed).
 * - EXTERNAL: requires workspace consent, AND the provider id (when known)
 *   must be in the allowed list. Fails closed on any gap.
 */
export function assertProviderAllowed(
  db: Db,
  workspaceId: string,
  privacyClass: PrivacyClass,
  providerId?: string,
): WorkspaceAiConsent {
  if (privacyClass !== "EXTERNAL") {
    return getConsent(db, workspaceId);
  }

  const consent = getConsent(db, workspaceId);

  if (!consent.externalAiAllowed) {
    throw new ConsentError(
      `Workspace ${workspaceId} has not consented to external AI use.`,
      "CONSENT_REQUIRED",
    );
  }

  if (providerId && consent.allowedExternalProviderIds.length > 0) {
    if (!consent.allowedExternalProviderIds.includes(providerId)) {
      throw new ConsentError(
        `Provider "${providerId}" is not in the workspace's allowed external-AI provider list.`,
        "PROVIDER_NOT_ALLOWED",
      );
    }
  }

  return consent;
}

/** Whether a workspace currently has external-AI consent. */
export function hasExternalAiConsent(db: Db, workspaceId: string): boolean {
  return getConsent(db, workspaceId).externalAiAllowed;
}

function parseProviderList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((p) => String(p));
    return [];
  } catch {
    return [];
  }
}
