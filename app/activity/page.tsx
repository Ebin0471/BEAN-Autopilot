"use client";

import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { ACTIVITY } from "@/lib/data";
import { COMMAND_CATALOGUE } from "@/lib/commands/catalogue";
import type { TaskState } from "@/lib/types";
import styles from "./page.module.css";

const STATE_META: Record<TaskState, { cls: string; label: string; dot: string }> = {
  success: { cls: "badge-success", label: "Success", dot: "var(--success)" },
  pending: { cls: "badge-warning", label: "Pending", dot: "var(--warning)" },
  queued: { cls: "badge-info", label: "Queued", dot: "var(--info)" },
  failed: { cls: "badge-danger", label: "Failed", dot: "var(--danger)" },
};

const APPROVAL_LABEL: Record<string, string> = {
  "not-required": "Not required",
  requested: "Requested",
  approved: "Approved",
  denied: "Denied",
};

export default function ActivityPage() {
  return (
    <main className="page">
      <PageHeader
        eyebrow="Activity & Execution Receipts"
        title="Task timeline"
        sub="Every consequential action produces a receipt: status, command, approval, evidence and next steps."
        icon="activity"
      />

      <DemoNote>
        The entries below are <strong>demonstration receipts</strong> and are clearly separate from real
        security records. CORE-02 adds a real command execution lifecycle (RECEIVED → VALIDATED → AWAITING_APPROVAL →
        AUTHORISED → RUNNING → VERIFIED / FAILED) and audit events; live records appear under your workspace when
        authenticated. No task has been executed in this demo view.
      </DemoNote>

      <section className="card" style={{ marginBottom: 22 }}>
        <p className="card-title"><Icon name="route" size={15} /> Command lifecycle (CORE-02)</p>
        <p className="card-sub">{COMMAND_CATALOGUE.length} registered commands route through one governed gateway.</p>
        <div className={styles.meta}>
          <span><Icon name="zap" size={13} /> {COMMAND_CATALOGUE.length} commands registered</span>
          <span><Icon name="shield" size={13} /> Passport-bound, audit-recorded</span>
        </div>
      </section>

      <div className={styles.timeline}>
        {ACTIVITY.map((a) => {
          const meta = STATE_META[a.state];
          return (
            <div key={a.id} className={styles.entry}>
              <span className={styles.dot} style={{ background: meta.dot }} />
              <div className={styles.entryBody}>
                <div className="row-between wrap">
                  <strong className={styles.task}>{a.task}</strong>
                  <span className={`badge ${meta.cls}`}><span className="badge-dot" />{meta.label}</span>
                </div>
                <div className={styles.meta}>
                  <span><Icon name="clock" size={13} /> {a.time}</span>
                  <span><Icon name="agents" size={13} /> {a.agent}</span>
                  <span className="mono">{a.command}</span>
                </div>
                <div className={styles.meta}>
                  <span><Icon name="shield" size={13} /> {APPROVAL_LABEL[a.approval]}</span>
                  <span className="dim"><Icon name="files" size={13} /> {a.evidence}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
