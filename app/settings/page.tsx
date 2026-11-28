"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "@/lib/workspace";
import styles from "./page.module.css";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`${styles.toggle} ${on ? styles.toggleOn : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className={styles.toggleKnob} />
    </button>
  );
}

function Field({
  label,
  desc,
  children,
}: {
  label: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.field}>
      <div>
        <strong className={styles.fieldLabel}>{label}</strong>
        <p className="dim">{desc}</p>
      </div>
      {children}
    </div>
  );
}

interface ConsentState {
  externalAiAllowed: boolean;
  allowedExternalProviderIds: string[];
  /** Effective usability: true only when consent is granted AND the allowlist
   *  is non-empty (matches assertProviderAllowed fail-closed semantics). */
  externalAiUsable: boolean;
  consentedAt: string | null;
}

interface ProviderOption {
  providerId: string;
  providerName: string;
  adapterType: string;
}

export default function SettingsPage() {
  const { workspace, setWorkspace } = useWorkspace();
  const [reduceMotion, setReduceMotion] = useState(true);
  const [highContrast, setHighContrast] = useState(false);

  // The display switches below genuinely adjust this view (document-level
  // attributes consumed by globals.css). They are local only — nothing is
  // saved or enforced by a backend.
  useEffect(() => {
    const el = document.documentElement;
    if (reduceMotion) el.setAttribute("data-motion", "reduced");
    else el.removeAttribute("data-motion");
  }, [reduceMotion]);

  useEffect(() => {
    const el = document.documentElement;
    if (highContrast) el.setAttribute("data-contrast", "high");
    else el.removeAttribute("data-contrast");
  }, [highContrast]);
  const [notifications, setNotifications] = useState(true);
  const [approvalPings, setApprovalPings] = useState(true);

  // External-AI consent (Area 4 + CORE-03G.2 finding #3): authorised,
  // workspace-scoped, audited. Workspace-keyed loading with a stale-response
  // guard so an old in-flight response can never overwrite a newer workspace's
  // state.
  const [session, setSession] = useState<{ workspaces: { id: string; kind: string; name: string }[] } | null>(null);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // Generation counter: incremented on every workspace switch so stale
  // in-flight load/update responses are discarded.
  const consentGenRef = useRef(0);

  // Resolve the real workspace id from the session, matching the selected kind.
  const workspaceId =
    session?.workspaces.find((w) => w.kind.toLowerCase() === workspace)?.id ??
    session?.workspaces[0]?.id ??
    null;

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setSession(s))
      .catch(() => setSession(null));
  }, []);

  // Load consent whenever the resolved workspace id changes. Each load gets a
  // generation number; only the latest generation may apply its result.
  useEffect(() => {
    if (!workspaceId) {
      consentGenRef.current++;
      setConsent(null);
      setProviders([]);
      setConsentError(null);
      setConsentBusy(false);
      return;
    }
    const gen = ++consentGenRef.current;
    setConsent(null); // show loading for the newly selected workspace
    setConsentError(null);
    setConsentBusy(false);
    (async () => {
      try {
        const res = await fetch(`/api/ai/consent?workspaceId=${workspaceId}`);
        if (gen !== consentGenRef.current) return; // stale: workspace switched
        if (res.ok) {
          const data = await res.json();
          if (gen !== consentGenRef.current) return; // stale
          setConsent({
            externalAiAllowed: data.consent?.externalAiAllowed ?? false,
            allowedExternalProviderIds: data.consent?.allowedExternalProviderIds ?? [],
            externalAiUsable: data.consent?.externalAiUsable ?? false,
            consentedAt: data.consent?.consentedAt ?? null,
          });
          setProviders(data.providers ?? []);
        }
      } catch {
        if (gen !== consentGenRef.current) return; // stale
        setConsentError("Could not load external-AI consent.");
      }
    })();
  }, [workspaceId]);

  const updateConsent = useCallback(
    async (next: { externalAiAllowed: boolean; allowedExternalProviderIds: string[] }) => {
      if (!workspaceId) return;
      const gen = consentGenRef.current; // capture current generation
      setConsentBusy(true);
      setConsentError(null);
      try {
        const res = await fetch(`/api/ai/consent?workspaceId=${workspaceId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        if (gen !== consentGenRef.current) return; // stale: workspace switched
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? "Consent update failed.");
        }
        const data = await res.json();
        if (gen !== consentGenRef.current) return; // stale
        setConsent({
          externalAiAllowed: data.consent.externalAiAllowed,
          allowedExternalProviderIds: data.consent.allowedExternalProviderIds,
          externalAiUsable: data.consent.externalAiUsable ?? false,
          consentedAt: data.consent.consentedAt,
        });
      } catch (e) {
        if (gen !== consentGenRef.current) return; // stale
        setConsentError(e instanceof Error ? e.message : "Consent update failed.");
      } finally {
        if (gen === consentGenRef.current) setConsentBusy(false);
      }
    },
    [workspaceId],
  );

  const toggleProvider = (providerId: string, enabled: boolean) => {
    if (!consent) return;
    const allowed = enabled
      ? Array.from(new Set([...consent.allowedExternalProviderIds, providerId]))
      : consent.allowedExternalProviderIds.filter((id) => id !== providerId);
    updateConsent({ externalAiAllowed: consent.externalAiAllowed, allowedExternalProviderIds: allowed });
  };
  return (
    <main className="page">
      <PageHeader
        eyebrow="Settings"
        title="Preferences & privacy"
        sub="Local UI preferences and governed external-AI consent."
        icon="settings"
      />

      <DemoNote>
        The display preferences below change <strong>this view only</strong> — they are not saved and
        do not change how Autopilot works. External-AI consent is different: it is enforced
        server-side, scoped to your workspace and recorded in the audit log.
      </DemoNote>

      <div className={`${styles.grid} ${styles.mt}`}>
        <section className="card">
          <p className="card-title"><Icon name="layers" size={15} /> Profile</p>
          <Field label="Display name" desc="Shown across the interface.">
            <input className="input" defaultValue="Demo user" />
          </Field>
          <Field label="Default workspace" desc="Initial workspace on launch.">
            <select className="select" value={workspace} onChange={(e) => setWorkspace(e.target.value as "personal" | "professional" | "business")}>
              <option value="personal">Personal</option>
              <option value="professional">Professional</option>
              <option value="business">Business</option>
            </select>
          </Field>
        </section>

        <section className="card">
          <p className="card-title"><Icon name="shield" size={15} /> Notifications</p>
          <Field label="Task notifications" desc="Notify on task state changes.">
            <Toggle on={notifications} onChange={setNotifications} />
          </Field>
          <Field label="Approval pings" desc="Notify when an action needs your approval.">
            <Toggle on={approvalPings} onChange={setApprovalPings} />
          </Field>
        </section>

        <section className="card">
          <p className="card-title"><Icon name="accessibility" size={15} /> Accessibility</p>
          <Field label="Reduce motion" desc="Minimise animations and transitions.">
            <Toggle on={reduceMotion} onChange={setReduceMotion} />
          </Field>
          <Field label="High contrast" desc="Strengthen text and border contrast.">
            <Toggle on={highContrast} onChange={setHighContrast} />
          </Field>
        </section>

        <section className="card">
          <p className="card-title"><Icon name="key" size={15} /> External AI consent</p>
          <p className="dim">
            External AI providers send your data outside this workspace. Consent is required before
            any external provider is used, and is enforced by the server (fail-closed). Changes are
            recorded in the audit log.
          </p>

          {!workspaceId ? (
            <p className="dim">No workspace session available — consent is managed per workspace.</p>
          ) : consent ? (
            <>
              <Field label="Allow external AI" desc="Grant consent. External AI is only usable when at least one provider is allowlisted.">
                <Toggle
                  on={consent.externalAiAllowed}
                  onChange={(v) => updateConsent({ externalAiAllowed: v, allowedExternalProviderIds: consent.allowedExternalProviderIds })}
                />
              </Field>

              {providers.length > 0 && (
                <div className={styles.field}>
                  <div>
                    <strong className={styles.fieldLabel}>Allowed external providers</strong>
                    <p className="dim">Explicit allowlist. Only listed providers may be used.</p>
                  </div>
                  <div className={styles.checkList}>
                    {providers.map((p) => (
                      <label key={p.providerId} className={styles.checkItem}>
                        <input
                          type="checkbox"
                          checked={consent.allowedExternalProviderIds.includes(p.providerId)}
                          disabled={consentBusy}
                          onChange={(e) => toggleProvider(p.providerId, e.target.checked)}
                        />
                        <span>{p.providerName} <span className="dim">({p.providerId})</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {consent.externalAiUsable ? (
                <p className="dim">External AI is usable for the allowlisted providers above.</p>
              ) : (
                <p className="dim">
                  External AI is not usable: {consent.externalAiAllowed
                    ? "no providers are allowlisted — add at least one provider to enable external AI."
                    : "consent has not been granted."}
                </p>
              )}
              <p className="dim">
                {consent.consentedAt ? `Last updated ${new Date(consent.consentedAt).toLocaleString()}` : "Not yet consented."}
              </p>
              {consentError && <p className="dim">{consentError}</p>}
            </>
          ) : (
            <p className="dim">Loading consent…</p>
          )}
        </section>

        <section className="card">
          <p className="card-title"><Icon name="key" size={15} /> Data & privacy</p>
          <p className="dim">
            BEAN Autopilot follows data minimisation: no credentials, OTPs or private keys are
            stored or requested. Full data, retention and deletion controls arrive with the
            backend milestone.
          </p>
          <button type="button" className="btn btn-sm" disabled title="Not available in this frontend yet">
            Manage data
          </button>
          <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>
            Data, retention and deletion controls are not part of this frontend yet.
          </p>
        </section>
      </div>
    </main>
  );
}
