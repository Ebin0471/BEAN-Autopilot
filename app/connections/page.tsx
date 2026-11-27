"use client";

import { useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { CAPABILITY_CATALOGUE } from "@/lib/commands/catalogue";
import styles from "./page.module.css";

const AVAILABILITY_META: Record<string, { cls: string; label: string }> = {
  PLANNED: { cls: "badge", label: "Planned" },
  REGISTERED: { cls: "badge badge-info", label: "Registered" },
  CONFIGURATION_REQUIRED: { cls: "badge badge-warning", label: "Config required" },
  AVAILABLE: { cls: "badge badge-success", label: "Available" },
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
        title="Capability fabric"
        sub="Registered execution surfaces and their real availability. A capability definition is not a connection — only AVAILABLE capabilities are connected and healthy."
        icon="connections"
      />

      <DemoNote>
        These are the <strong>real registered capability definitions</strong> from the CORE-02 capability
        fabric. Most are PLANNED — no external integration is connected in CORE-02. Only the internal
        platform registry is AVAILABLE. States are genuine, not fabricated.
      </DemoNote>

      <div className={`${styles.grid} ${styles.mt}`}>
        {CAPABILITY_CATALOGUE.map((c) => {
          const meta = AVAILABILITY_META[c.availabilityStatus] ?? { cls: "badge", label: c.availabilityStatus };
          const isAvailable = c.availabilityStatus === "AVAILABLE";
          return (
            <div key={c.capabilityId} className="card">
              <div className="row-between">
                <span className={styles.iconBox}>
                  <Icon name={CATEGORY_ICON[c.category] ?? "box"} size={20} />
                </span>
                <span className={`badge ${meta.cls}`}>
                  <span className="badge-dot" />
                  {meta.label}
                </span>
              </div>
              <h3 className={styles.name}>{c.name}</h3>
              <p className="dim">{c.description}</p>
              <div className={styles.metaRow}>
                <span className="badge">{c.capabilityId}</span>
                <span className="badge badge-gold">{c.trustLevel}</span>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-block"
                disabled={!isAvailable}
                onClick={() => setAttempted((a) => ({ ...a, [c.capabilityId]: isAvailable ? "Internal registry — active" : "Not available in CORE-02" }))}
              >
                <Icon name="key" size={14} />
                {isAvailable ? "Active" : "Connect"}
              </button>
              {attempted[c.capabilityId] && (
                <p className={`dim mono ${styles.attempt}`}>{attempted[c.capabilityId]}</p>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
