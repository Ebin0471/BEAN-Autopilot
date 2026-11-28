"use client";

import { useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { CAPABILITY_CATALOGUE } from "@/lib/commands/catalogue";
import styles from "./page.module.css";

/** User-friendly status; the raw capability status stays in the details panel. */
const AVAILABILITY_META: Record<string, { cls: string; label: string }> = {
  PLANNED: { cls: "badge", label: "Not yet available" },
  REGISTERED: { cls: "badge badge-info", label: "Registered, not connected" },
  CONFIGURATION_REQUIRED: { cls: "badge badge-warning", label: "Needs configuration" },
  AVAILABLE: { cls: "badge badge-success", label: "Connected" },
  DEGRADED: { cls: "badge badge-warning", label: "Degraded" },
  UNAVAILABLE: { cls: "badge", label: "Unavailable" },
  DISABLED: { cls: "badge", label: "Disabled" },
  REVOKED: { cls: "badge badge-danger", label: "Revoked" },
};

const CATEGORY_ICON: Record<string, string> = {
  browser: "browser",
  desktop: "windows",
  mobile: "android",
  email: "email",
  calendar: "calendar",
  file: "files",
  crm: "apps",
  erp: "layers",
  accounting: "grid",
  iot: "iot",
  platform: "apps",
  other: "grid",
};

export default function ConnectionsPage() {
  const [attempted, setAttempted] = useState<Record<string, string>>({});

  return (
    <main className="page">
      <PageHeader
        eyebrow="Connections"
        title="Apps & Services"
        sub="Apps and services Autopilot can work with. A listed capability is not the same as a connection — only items marked Connected are actually connected."
        icon="connections"
      />

      <DemoNote>
        These are the <strong>real registered capability definitions</strong>. Most are planned —
        no external integration is connected in this view. Only the internal platform registry is
        connected. States are genuine, not fabricated.
      </DemoNote>

      <div className={`${styles.legend} ${styles.mt}`}>
        <span className="badge badge-success"><span className="badge-dot" />Connected — works now</span>
        <span className="badge badge-warning"><span className="badge-dot" />Needs configuration — set up first</span>
        <span className="badge"><span className="badge-dot" />Not yet available — planned, not connected</span>
      </div>

      <div className={styles.grid}>
        {CAPABILITY_CATALOGUE.map((c) => {
          const meta = AVAILABILITY_META[c.availabilityStatus] ?? { cls: "badge", label: c.availabilityStatus };
          const isAvailable = c.availabilityStatus === "AVAILABLE";
          return (
            <div key={c.capabilityId} className="card">
              <div className="row-between">
                <span className={styles.iconBox}>
                  <Icon name={CATEGORY_ICON[c.category] ?? "grid"} size={20} />
                </span>
                <span className={`badge ${meta.cls}`}>
                  <span className="badge-dot" />
                  {meta.label}
                </span>
              </div>
              <h3 className={styles.name}>{c.name}</h3>
              <p className="dim">{c.description}</p>
              <details className={styles.details}>
                <summary>Technical details</summary>
                <dl className={styles.techList}>
                  <div><dt>Capability ID</dt><dd className="mono">{c.capabilityId}</dd></div>
                  <div><dt>Provider</dt><dd className="mono">{c.provider}</dd></div>
                  <div><dt>Trust level</dt><dd className="mono">{c.trustLevel}</dd></div>
                  <div><dt>Availability</dt><dd className="mono">{c.availabilityStatus}</dd></div>
                  <div><dt>Health</dt><dd className="mono">{c.healthStatus}</dd></div>
                  <div>
                    <dt>Supported commands</dt>
                    <dd className="mono">{c.supportedCommands.length ? c.supportedCommands.join(", ") : "—"}</dd>
                  </div>
                  {c.requiredScopes.length > 0 && (
                    <div>
                      <dt>Required scopes</dt>
                      <dd className="mono">{c.requiredScopes.join(", ")}</dd>
                    </div>
                  )}
                </dl>
              </details>
              <button
                type="button"
                className="btn btn-sm btn-block"
                disabled={!isAvailable}
                onClick={() =>
                  setAttempted((a) => ({
                    ...a,
                    [c.capabilityId]: isAvailable ? "Internal registry — active" : "Not available in this view",
                  }))
                }
              >
                <Icon name="key" size={14} />
                {isAvailable ? "Active" : "Not available yet"}
              </button>
              {attempted[c.capabilityId] && (
                <p className={`dim ${styles.attempt}`}>{attempted[c.capabilityId]}</p>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
