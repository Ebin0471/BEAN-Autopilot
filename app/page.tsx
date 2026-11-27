"use client";

import Link from "next/link";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "@/lib/workspace";
import {
  ACTIVITY,
  PENDING_APPROVALS,
  RECENT_TASKS,
  SUGGESTED_ACTIONS,
} from "@/lib/data";
import type { TaskState } from "@/lib/types";
import styles from "./page.module.css";

const TASK_STATE: Record<TaskState, string> = {
  success: "badge-success",
  pending: "badge-warning",
  queued: "badge-info",
  failed: "badge-danger",
};

const STATE_LABEL: Record<TaskState, string> = {
  success: "Success",
  pending: "Pending approval",
  queued: "Queued",
  failed: "Failed",
};

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const { workspaceMeta } = useWorkspace();

  return (
    <main className="page">
      <PageHeader
        eyebrow="Home"
        title={`${greeting()} — ${workspaceMeta.label} workspace`}
        sub={`A chat-first operating layer for ${workspaceMeta.blurb.toLowerCase()}. Describe an outcome in plain language; the platform plans, authorises, executes and verifies.`}
        icon="home"
      />

      <DemoNote>
        This is a <strong>UI-01 demonstration shell</strong>. All overviews, tasks, approvals and
        activity below are illustrative placeholders — there is no live backend, agent execution or
        real data yet.
      </DemoNote>

      <div className={`${styles.heroComposer} ${styles.mt}`}>
        <div className={styles.composer}>
          <label className="field-label" htmlFor="home-prompt">
            Universal prompt composer
          </label>
          <textarea
            id="home-prompt"
            className="textarea"
            placeholder={`Describe an outcome in plain language — e.g. “${SUGGESTED_ACTIONS[0]}”`}
          />
          <div className={styles.composerActions}>
            <span className="dim mono">Tamil · Tanglish · English supported</span>
            <Link href="/chat" className="btn btn-primary">
              <Icon name="send" size={15} />
              Open in Chat
            </Link>
          </div>
        </div>

        <div className={styles.quickAccess}>
          <Link href="/automation" className={styles.qaCard}>
            <Icon name="automation" size={20} />
            <div>
              <strong>Automation Studio</strong>
              <span>Build node-based workflows visually</span>
            </div>
            <Icon name="arrowRight" size={16} className={styles.qaArrow} />
          </Link>
        </div>
      </div>

      <div className={`${styles.grid3} ${styles.mt}`}>
        {/* suggested actions */}
        <section className="card">
          <p className="card-title"><Icon name="zap" size={15} /> Suggested actions</p>
          <p className="card-sub">Try these to explore the workflow.</p>
          <ul className={styles.actionList}>
            {SUGGESTED_ACTIONS.map((a) => (
              <li key={a}>
                <Link href="/chat" className={styles.actionLink}>
                  <span className={styles.actionBullet} />
                  {a}
                  <Icon name="arrowRight" size={14} className={styles.actionArrow} />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {/* recent tasks */}
        <section className="card">
          <p className="card-title"><Icon name="clock" size={15} /> Recent tasks</p>
          <p className="card-sub">Demonstration entries only.</p>
          <ul className={styles.taskList}>
            {RECENT_TASKS.map((t) => (
              <li key={t.id} className={styles.taskRow}>
                <span className={styles.taskInfo}>
                  <strong>{t.title}</strong>
                  <span className="dim mono">{t.time}</span>
                </span>
                <span className={`badge ${TASK_STATE[t.state]}`}>
                  <span className="badge-dot" />
                  {STATE_LABEL[t.state]}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* pending approvals */}
        <section className="card">
          <p className="card-title"><Icon name="shield" size={15} /> Pending approvals</p>
          <p className="card-sub">Actions awaiting explicit approval (R3+).</p>
          <ul className={styles.approvalList}>
            {PENDING_APPROVALS.map((p) => (
              <li key={p.id} className={styles.approvalRow}>
                <span className={styles.approvalInfo}>
                  <strong>{p.task}</strong>
                  <span className="dim">{p.agent} · {p.risk}</span>
                </span>
                <span className="badge badge-warning"><span className="badge-dot" />Awaiting</span>
              </li>
            ))}
          </ul>
          <Link href="/activity" className="btn btn-ghost btn-sm btn-block">View receipts</Link>
        </section>
      </div>

      <div className={`${styles.grid2} ${styles.mt}`}>
        {/* agent workforce overview */}
        <section className="card">
          <div className="row-between">
            <p className="card-title" style={{ marginBottom: 0 }}><Icon name="agents" size={15} /> Agent workforce</p>
            <Link href="/agents" className="btn btn-ghost btn-sm">Browse all</Link>
          </div>
          <p className="card-sub">Documented agents are <strong>planned</strong>, not implemented.</p>
          <div className={styles.agentBars}>
            <div>
              <div className={styles.agentBarRow}>
                <span>Universal</span><span className="dim mono">20 planned</span>
              </div>
              <div className={styles.bar}><span className={styles.barFill} style={{ width: "100%" }} /></div>
            </div>
            <div>
              <div className={styles.agentBarRow}>
                <span>Personal</span><span className="dim mono">9 planned</span>
              </div>
              <div className={styles.bar}><span className={styles.barFill} style={{ width: "100%" }} /></div>
            </div>
            <div>
              <div className={styles.agentBarRow}>
                <span>Professional</span><span className="dim mono">17 planned</span>
              </div>
              <div className={styles.bar}><span className={styles.barFill} style={{ width: "100%" }} /></div>
            </div>
            <div>
              <div className={styles.agentBarRow}>
                <span>Business</span><span className="dim mono">20 planned</span>
              </div>
              <div className={styles.bar}><span className={styles.barFill} style={{ width: "100%" }} /></div>
            </div>
          </div>
          <p className={`dim ${styles.mini}`}>No agent is active or configured in UI-01.</p>
        </section>

        {/* recent activity */}
        <section className="card">
          <div className="row-between">
            <p className="card-title" style={{ marginBottom: 0 }}><Icon name="activity" size={15} /> Recent activity</p>
            <Link href="/activity" className="btn btn-ghost btn-sm">All</Link>
          </div>
          <p className="card-sub">Demonstration timeline — no real execution.</p>
          <ul className={styles.activityList}>
            {ACTIVITY.slice(0, 4).map((a) => (
              <li key={a.id} className={styles.activityRow}>
                <span className={`badge ${TASK_STATE[a.state]}`}><span className="badge-dot" /></span>
                <span className={styles.activityInfo}>
                  <strong>{a.task}</strong>
                  <span className="dim mono">{a.time} · {a.agent} · {a.command}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
