"use client";

import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { ACTIVITY } from "@/lib/data";
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
        These timeline entries are <strong>demonstration receipts</strong>. No task has been executed —
        there is no backend in UI-01. States (success, pending, queued, failed) illustrate the receipt format only.
      </DemoNote>

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
