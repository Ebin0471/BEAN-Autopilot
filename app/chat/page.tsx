"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "@/lib/workspace";
import { CLIENT_MODELS, type ClientModel } from "@/lib/ai/catalogue";
import { SUGGESTED_ACTIONS } from "@/lib/data";
import type { TaskPlan } from "@/lib/ai/types";
import type { ChatMessage } from "@/lib/types";
import styles from "./page.module.css";

interface ConvItem {
  id: string;
  title: string;
  updatedAt: string;
}

interface ExecutionReceipt {
  executionId: string;
  commandId: string;
  status: string;
  passportId: string | null;
  errorCode?: string;
}

interface StreamEvent {
  type: string;
  delta?: string;
  content?: string;
  taskCategory?: string;
  requiresClarification?: boolean;
  missingInformation?: string[];
  plan?: TaskPlan;
  execution?: {
    executionId: string;
    commandId: string;
    status: string;
    passportId: string | null;
    errorCode?: string;
  };
  status?: string;
  messageId?: string;
  limitations?: string[];
  code?: string;
  message?: string;
}

const EXEC_STATUS: Record<string, { cls: string; label: string }> = {
  VERIFIED: { cls: "badge-success", label: "Completed and verified" },
  AUTHORIZED: { cls: "badge-info", label: "Authorised" },
  RUNNING: { cls: "badge-info", label: "Running" },
  VALIDATED: { cls: "badge-info", label: "Checked" },
  RECEIVED: { cls: "badge-info", label: "Received" },
  AWAITING_APPROVAL: { cls: "badge-warning", label: "Needs your approval" },
  PARTIAL: { cls: "badge-warning", label: "Partly completed" },
  FAILED: { cls: "badge-danger", label: "Failed" },
};

export default function ChatPage() {
  const { workspace, workspaceMeta } = useWorkspace();
  const [session, setSession] = useState<{ workspaces: { id: string; kind: string; name: string }[] } | null>(null);
  const [conversations, setConversations] = useState<ConvItem[]>([]);
  const [activeConv, setActiveConv] = useState<ConvItem | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [modelId, setModelId] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [executions, setExecutions] = useState<ExecutionReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Resolve the real workspace id from the session, matching the selected kind.
  const workspaceId = session?.workspaces.find((w) => w.kind.toLowerCase() === workspace)?.id
    ?? session?.workspaces[0]?.id
    ?? null;

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session");
      if (res.ok) setSession(await res.json());
    } catch {
      setSession(null);
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/ai/conversations?workspaceId=${workspaceId}`);
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [workspaceId]);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations, workspace]);

  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === "function") {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamText]);

  function startNewConversation() {
    if (!workspaceId) return;
    const title = `Chat · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    fetch("/api/ai/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, title }),
    })
      .then((r) => r.json())
      .then((data) => {
        const conv = data.conversation as ConvItem;
        setConversations((c) => [conv, ...c]);
        setActiveConv(conv);
        setMessages([
          {
            id: "sys",
            role: "system",
            text: `Autopilot is ready. Describe an outcome in plain language — it will plan the steps, and only runs actions with your approval.`,
          },
        ]);
        setPlan(null);
        setExecutions([]);
        setError(null);
      })
      .catch(() => setError("Could not create a conversation."));
  }

  function selectConversation(conv: ConvItem) {
    setActiveConv(conv);
    setPlan(null);
    setExecutions([]);
    setError(null);
    fetch(`/api/ai/conversations/${conv.id}/messages?workspaceId=${workspaceId}`)
      .then((r) => r.json())
      .then((data) => {
        const msgs = (data.messages ?? []).map((m: { id: string; role: string; content: string }) => ({
          id: m.id,
          role: m.role as ChatMessage["role"],
          text: m.content,
        }));
        setMessages(msgs.length ? msgs : [{ id: "sys", role: "system", text: "Opened conversation." }]);
      })
      .catch(() => setMessages([]));
  }

  async function send() {
    const text = draft.trim();
    if (!text || streaming || !activeConv || !workspaceId) return;
    setError(null);
    setPlan(null);
    setExecutions([]);
    setStreamText("");
    setMessages((m) => [...m, { id: `u${Date.now()}`, role: "user", text }]);
    setDraft("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          conversationId: activeConv.id,
          message: text,
          autoExecuteSafe: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line) as StreamEvent;
          if (evt.type === "delta" && evt.delta) {
            acc += evt.delta;
            setStreamText(acc);
          } else if (evt.type === "plan" && evt.plan) {
            setPlan(evt.plan);
          } else if (evt.type === "execution" && evt.execution) {
            setExecutions((e) => [...e, evt.execution!]);
          } else if (evt.type === "error") {
            setError(evt.message ?? "The turn failed.");
          }
        }
      }

      if (acc) {
        setMessages((m) => [...m, { id: `a${Date.now()}`, role: "assistant", text: acc }]);
      }
      refreshConversations();
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        if (acc) setMessages((m) => [...m, { id: `a${Date.now()}`, role: "assistant", text: acc + " [stopped]" }]);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setStreaming(false);
      setStreamText("");
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const availableModels = CLIENT_MODELS;
  const isEmpty = messages.length === 0 && !streaming && !error;

  return (
    <main className="page">
      <PageHeader
        eyebrow="Autopilot Chat"
        title="Chat"
        sub="Describe what you want in plain language. Autopilot plans the steps, and only runs actions with your approval."
        icon="chat"
      />

      <div className={styles.layout}>
        {/* conversation history */}
        <aside className={styles.history}>
          <div className={styles.historyHead}>
            <p className="field-label" style={{ marginBottom: 0 }}>Conversations</p>
            <div className={styles.historyActions}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setHistoryOpen((v) => !v)}
                aria-expanded={historyOpen}
                aria-label={historyOpen ? "Hide conversation list" : "Show conversation list"}
              >
                <Icon name={historyOpen ? "x" : "menu"} size={14} />
                {historyOpen ? "Hide" : "Show"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={startNewConversation} disabled={!workspaceId}>
                <Icon name="plus" size={14} /> New chat
              </button>
            </div>
          </div>
          {historyOpen && (
            <ul className={styles.convList}>
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`${styles.convItem} ${activeConv?.id === c.id ? styles.convActive : ""}`}
                    onClick={() => selectConversation(c)}
                    aria-current={activeConv?.id === c.id ? "true" : undefined}
                  >
                    <Icon name="chat" size={15} />
                    <span className={styles.convInfo}>
                      <strong>{c.title}</strong>
                      <span className="dim mono">
                        {new Date(c.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {conversations.length === 0 && (
                <li className="dim" style={{ fontSize: 12, padding: "8px 4px" }}>No conversations yet.</li>
              )}
            </ul>
          )}
          {!workspaceId && (
            <DemoNote>Sign in to create and use conversations.</DemoNote>
          )}
        </aside>

        {/* conversation */}
        <section className={styles.conversation}>
          <div className={styles.contextBar}>
            <span className="badge badge-gold">
              <Icon name="layers" size={13} />
              {workspaceMeta.label} context
            </span>
            <div className={styles.agentSelect}>
              <label className="sr-only" htmlFor="chat-model">Model</label>
              <Icon name="zap" size={14} />
              <select
                id="chat-model"
                className="select"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                disabled={!workspaceId}
              >
                <option value="">Auto-route</option>
                {availableModels.map((m: ClientModel) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.modelName} · {m.providerId}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.messages}>
            {isEmpty && (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}>
                  <Icon name="spark" size={22} />
                </span>
                <p className={styles.emptyTitle}>Ask Autopilot to help with something</p>
                <p className="dim">Type a request below, or pick an idea:</p>
                <div className={styles.emptyChips}>
                  {SUGGESTED_ACTIONS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={styles.emptyChip}
                      onClick={() => setDraft(a)}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`${styles.msg} ${m.role === "user" ? styles.msgUser : styles.msgSystem}`}>
                <span className={styles.msgRole}>
                  {m.role === "user" ? "You" : m.role === "system" ? "System" : "Agent"}
                </span>
                <p className={styles.msgText}>{m.text}</p>
              </div>
            ))}
            {streaming && streamText && (
              <div className={`${styles.msg} ${styles.msgSystem}`}>
                <span className={styles.msgRole}>Agent</span>
                <p className={styles.msgText}>{streamText}</p>
              </div>
            )}
            {streaming && !streamText && (
              <div className={`${styles.msg} ${styles.msgSystem}`}>
                <span className={styles.msgRole}>Agent</span>
                <p className={styles.msgText}>
                  <span className={styles.thinking}>Autopilot is thinking…</span>
                </p>
              </div>
            )}
            {error && (
              <div className={`${styles.msg} ${styles.msgSystem}`}>
                <span className={styles.msgRole} style={{ color: "var(--danger)" }}>Something went wrong</span>
                <p className={styles.msgText} style={{ borderColor: "var(--danger)" }}>{error}</p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className={styles.composer}>
            <textarea
              className="textarea"
              placeholder={workspaceId ? "Describe an outcome in plain language…" : "Sign in to start chatting…"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              aria-label="Message — press Enter to send, Shift+Enter for a new line"
              disabled={!workspaceId}
            />
            <div className={styles.composerBar}>
              <div className={styles.composerTools}>
                <span className="dim">Press Enter to send · Shift+Enter for a new line</span>
              </div>
              {streaming ? (
                <button type="button" className={`${styles.btnStop} btn`} onClick={stop}>
                  <Icon name="x" size={15} /> Stop
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={send} disabled={!draft.trim() || !activeConv || !workspaceId}>
                  <Icon name="send" size={15} /> Send
                </button>
              )}
            </div>
          </div>
        </section>

        {/* planning & receipts */}
        <aside className={styles.planning}>
          {plan ? (
            <section className="card">
              <p className="card-title"><Icon name="route" size={15} /> What Autopilot plans to do</p>
              <p className="card-sub">{plan.objective}</p>
              {plan.approvalRequirements.length > 0 && (
                <p className={styles.needApproval}>
                  <Icon name="shield" size={14} />
                  This plan includes steps that need your approval before they run ({plan.approvalRequirements.length}).
                </p>
              )}
              <ol className={styles.stageList}>
                {plan.tasks.map((t) => (
                  <li key={t.taskId} className={styles.stageItem}>
                    <span className={styles.stageNum}>{t.taskId.replace("t", "")}</span>
                    <span>{t.description}</span>
                  </li>
                ))}
              </ol>
              <details className={styles.techDetails}>
                <summary>Technical details</summary>
                <dl className={styles.techList}>
                  <div><dt>Risk class</dt><dd className="mono">{plan.riskClassification}</dd></div>
                  <div><dt>Estimated complexity</dt><dd className="mono">{plan.estimatedComplexity}</dd></div>
                  <div><dt>Task IDs</dt><dd className="mono">{plan.tasks.map((t) => t.taskId).join(", ") || "—"}</dd></div>
                  <div>
                    <dt>Approval requirements</dt>
                    <dd className="mono">{plan.approvalRequirements.join(", ") || "None"}</dd>
                  </div>
                  {plan.unresolvedQuestions.length > 0 && (
                    <div>
                      <dt>Open questions</dt>
                      <dd className="mono">{plan.unresolvedQuestions.join(", ")}</dd>
                    </div>
                  )}
                </dl>
              </details>
            </section>
          ) : (
            <section className="card">
              <p className="card-title"><Icon name="route" size={15} /> What Autopilot plans to do</p>
              <p className="card-sub">A plan appears here when you send a request.</p>
            </section>
          )}

          <section className="card">
            <p className="card-title"><Icon name="activity" size={15} /> Actions and results</p>
            <p className="card-sub">Every action runs through the governed gateway and produces a receipt.</p>
            {executions.length === 0 ? (
              <p className="dim" style={{ fontSize: 13 }}>No actions yet.</p>
            ) : (
              <ul className={styles.receiptList}>
                {executions.map((e) => {
                  const status = EXEC_STATUS[e.status] ?? { cls: "badge", label: e.status };
                  return (
                    <li key={e.executionId} className={styles.receiptItem}>
                      <span className={`badge ${status.cls}`}>
                        <span className="badge-dot" />
                        {status.label}
                      </span>
                      <details className={styles.techDetails}>
                        <summary>Details</summary>
                        <dl className={styles.techList}>
                          <div><dt>Command</dt><dd className="mono">{e.commandId}</dd></div>
                          <div><dt>Execution</dt><dd className="mono">{e.executionId}</dd></div>
                          <div><dt>Passport</dt><dd className="mono">{e.passportId ?? "—"}</dd></div>
                          <div><dt>Status</dt><dd className="mono">{e.status}</dd></div>
                          {e.errorCode && <div><dt>Error</dt><dd className="mono">{e.errorCode}</dd></div>}
                        </dl>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card">
            <p className="card-title"><Icon name="shield" size={15} /> How actions are governed</p>
            <p className="card-sub">Autopilot plans, then every action is checked before it runs.</p>
            <div className={styles.sourceRow}>
              <Icon name="check" size={15} />
              <span>Actions run only through the governed gateway with approval passports.</span>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
