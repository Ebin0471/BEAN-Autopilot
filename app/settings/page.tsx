"use client";

import { useState } from "react";
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

export default function SettingsPage() {
  const { workspace, setWorkspace } = useWorkspace();
  const [reduceMotion, setReduceMotion] = useState(true);
  const [highContrast, setHighContrast] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [approvalPings, setApprovalPings] = useState(true);

  return (
    <main className="page">
      <PageHeader
        eyebrow="Settings"
        title="Preferences & privacy"
        sub="Local UI preferences only. No account, authentication or cloud profile exists in UI-01."
        icon="settings"
      />

      <DemoNote>
        These controls adjust the <strong>local UI shell only</strong>. There is no authentication,
        database or cloud profile behind them in UI-01.
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
          <Field label="Approval pings" desc="Notify when approval is required (R3+).">
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
          <p className="card-title"><Icon name="key" size={15} /> Data & privacy</p>
          <p className="dim">
            BEAN Autopilot follows data minimisation: no credentials, OTPs or private keys are stored or
            requested. Full data, retention and deletion controls arrive with the backend milestone.
          </p>
          <button type="button" className="btn btn-sm" disabled title="Backend feature not present in UI-01">
            Manage data (not available in UI-01)
          </button>
        </section>
      </div>
    </main>
  );
}
