"use client";

import { useMemo, useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "@/lib/workspace";
import { AGENTS } from "@/lib/data";
import { COMMAND_CATALOGUE } from "@/lib/commands/catalogue";
import type { ChatMessage } from "@/lib/types";
import styles from "./page.module.css";

const STAGES = ["Understand", "Plan", "Approval", "Execute", "Verify", "Report"] as const;

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "m0",
    role: "system",
    text: `Describe an outcome in plain language. CORE-02 provides a registered command catalogue (${COMMAND_CATALOGUE.length} commands) and a governed command gateway. Real agent reasoning and execution belong to CORE-03 and later — this UI does not fabricate a plan or execute anything.`,
    demo: true,
  },
];

const CONVERSATIONS = [
  { id: "c1", title: "Weekly planning", time: "09:10" },
  { id: "c2", title: "Client follow-up", time: "Yesterday" },
  { id: "c3", title: "Travel research", time: "Mon" },
];

export default function ChatPage() {
  const { workspaceMeta } = useWorkspace();
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [draft, setDraft] = useState("");
  const [agent, setAgent] = useState("auto");

  const agentOptions = useMemo(() => AGENTS.slice(0, 12), []);

  function send() {
    const text = draft.trim();
    if (!text) return;
    const userMsg: ChatMessage = { id: `u${Date.now()}`, role: "user", text };
    const notice: ChatMessage = {
      id: `s${Date.now()}`,
      role: "system",
      demo: true,
      text: "Demo mode — no agent execution is connected. Command discovery and preview are available through the server-side command gateway (/api/commands); agent reasoning and execution are CORE-03+.",
    };
    setMessages((m) => [...m, userMsg, notice]);
    setDraft("");
  }

  return (
    <main className="page">
      <PageHeader
        eyebrow="Autopilot Chat"
        title="Central Autopilot Chat"
        sub="The primary product experience: describe an outcome, then review the plan, approvals, execution and verified receipt."
        icon="chat"
      />

      <div className={styles.layout}>
        {/* conversation history */}
        <aside className={styles.history}>
          <p className="field-label">Conversation history</p>
          <ul className={styles.convList}>
            {CONVERSATIONS.map((c) => (
              <li key={c.id} className={styles.convItem}>
                <Icon name="chat" size={15} />
                <span className={styles.convInfo}>
                  <strong>{c.title}</strong>
                  <span className="dim mono">{c.time}</span>
                </span>
              </li>
            ))}
          </ul>
          <DemoNote>History entries are demonstration items.</DemoNote>
        </aside>

        {/* conversation */}
        <section className={styles.conversation}>
          <div className={styles.contextBar}>
            <span className={`badge badge-gold`}>
              <Icon name="layers" size={13} />
              {workspaceMeta.label} context
            </span>
            <label className={styles.agentSelect}>
              <Icon name="agents" size={14} />
              <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="auto">Auto-route</option>
                {agentOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.messages}>
            {messages.map((m) => (
              <div key={m.id} className={`${styles.msg} ${m.role === "user" ? styles.msgUser : styles.msgSystem}`}>
                <span className={styles.msgRole}>
                  {m.role === "user" ? "You" : m.role === "system" ? "System" : "Agent"}
                  {m.demo && <span className={styles.msgDemo}>demo</span>}
                </span>
                <p className={styles.msgText}>{m.text}</p>
              </div>
            ))}
          </div>

          <div className={styles.composer}>
            <textarea
              className="textarea"
              placeholder="Describe an outcome in plain language…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              aria-label="Message"
            />
            <div className={styles.composerBar}>
              <div className={styles.composerTools}>
                <button type="button" className={styles.toolBtn} aria-label="Attach file" title="Attachments — demo">
                  <Icon name="attach" size={17} />
                </button>
                <button type="button" className={styles.toolBtn} aria-label="Voice input" title="Voice input — demo">
                  <Icon name="mic" size={17} />
                </button>
                <span className="dim mono">Enter to send · Shift+Enter for newline</span>
              </div>
              <button type="button" className="btn btn-primary" onClick={send} disabled={!draft.trim()}>
                <Icon name="send" size={15} />
                Send
              </button>
            </div>
          </div>
        </section>

        {/* planning & receipts */}
        <aside className={styles.planning}>
          <section className="card">
            <p className="card-title"><Icon name="route" size={15} /> Task plan &amp; progress</p>
            <p className="card-sub">Conversational workflow — demonstration.</p>
            <ol className={styles.stageList}>
              {STAGES.map((s, i) => (
                <li key={s} className={styles.stageItem}>
                  <span className={styles.stageNum}>{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            <p className={`dim ${styles.mini}`}>No stage runs automatically in UI-01.</p>
          </section>

          <section className="card">
            <p className="card-title"><Icon name="shield" size={15} /> Approval requests</p>
            <p className="card-sub">R3+ actions need explicit approval.</p>
            <div className={styles.approvalCard}>
              <strong>Draft invoice for client</strong>
              <span className="dim">invoicing · R3</span>
              <span className="badge badge-warning"><span className="badge-dot" />Awaiting</span>
            </div>
          </section>

          <section className="card">
            <p className="card-title"><Icon name="activity" size={15} /> Execution receipt</p>
            <p className="card-sub">Status, evidence and next steps.</p>
            <dl className={styles.receipt}>
              <div><dt>Status</dt><dd><span className="badge badge-info">Queued</span></dd></div>
              <div><dt>Command</dt><dd className="mono">invoicing.draft</dd></div>
              <div><dt>Evidence</dt><dd className="dim">Demo — no real execution</dd></div>
              <div><dt>Next</dt><dd className="dim">Awaiting approval</dd></div>
            </dl>
          </section>

          <section className="card">
            <p className="card-title"><Icon name="files" size={15} /> Sources &amp; evidence</p>
            <p className="card-sub">Verified from authoritative sources.</p>
            <div className={styles.sourceRow}>
              <Icon name="check" size={15} />
              <span>Evidence will be attached after real verification.</span>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
