"use client";

import { useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { CONNECTIONS } from "@/lib/data";
import styles from "./page.module.css";

const STATE_META = {
  "not-connected": { cls: "badge", label: "Not connected" },
  available: { cls: "badge badge-gold", label: "Available" },
  connected: { cls: "badge badge-success", label: "Connected" },
} as const;

export default function ConnectionsPage() {
  const [attempted, setAttempted] = useState<Record<string, string>>({});

  return (
    <main className="page">
      <PageHeader
        eyebrow="Connections"
        title="Connection surfaces"
        sub="The platforms BEAN Autopilot can integrate with. UI-01 shows the connection surface — none are connected yet."
        icon="connections"
      />

      <DemoNote>
        All surfaces below are <strong>not connected</strong>. The states shown are genuine — no
        integration is live in UI-01. Connecting a surface requires a backend integration milestone.
      </DemoNote>

      <div className={`${styles.grid} ${styles.mt}`}>
        {CONNECTIONS.map((c) => (
          <div key={c.id} className="card">
            <div className="row-between">
              <span className={styles.iconBox}>
                <Icon name={c.icon} size={20} />
              </span>
              <span className={`badge ${STATE_META[c.state].cls}`}>
                <span className="badge-dot" />
                {STATE_META[c.state].label}
              </span>
            </div>
            <h3 className={styles.name}>{c.name}</h3>
            <p className="dim">{c.note}</p>
            <button
              type="button"
              className="btn btn-sm btn-block"
              onClick={() => setAttempted((a) => ({ ...a, [c.id]: "Not available in UI-01" }))}
            >
              <Icon name="key" size={14} />
              Connect
            </button>
            {attempted[c.id] && (
              <p className={`dim mono ${styles.attempt}`}>{attempted[c.id]}</p>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
