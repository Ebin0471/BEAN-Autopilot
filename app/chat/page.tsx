"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "@/lib/workspace";
import {
  CLIENT_MODELS,
  CLIENT_PROVIDERS,
  type ClientModel,
} from "@/lib/ai/catalogue";
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
            text: `Connected to the CORE-03 intelligence engine. ${CLIENT_PROVIDERS.length} provider(s), ${CLIENT_MODELS.length} model(s) registered. Describe an outcome — Autopilot will understand, plan and execute only permitted commands through the governed gateway.`,
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <p className="field-label">Conversation history</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={startNewConversation} disabled={!workspaceId}>
              <Icon name="plus" size={14} /> New
            </button>
          </div>
          <ul className={styles.convList}>
            {conversations.map((c) => (
              <li
                key={c.id}
                className={`${styles.convItem} ${activeConv?.id === c.id ? "active" : ""}`}
                onClick={() => selectConversation(c)}
              >
                <Icon name="chat" size={15} />
                <span className={styles.convInfo}>
                  <strong>{c.title}</strong>
                  <span className="dim mono">{new Date(c.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </span>
              </li>
            ))}
            {conversations.length === 0 && (
              <li className="dim" style={{ fontSize: 12, padding: "8px 4px" }}>No conversations yet.</li>
            )}
          </ul>
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
            <label className={styles.agentSelect}>
              <Icon name="zap" size={14} />
              <select
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
            </label>
          </div>

          <div className={styles.messages}>
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
            {error && (
              <div className={`${styles.msg} ${styles.msgSystem}`}>
                <span className={styles.msgRole} style={{ color: "var(--danger)" }}>Error</span>
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
              aria-label="Message"
              disabled={!workspaceId}
            />
            <div className={styles.composerBar}>
              <div className={styles.composerTools}>
                <span className="dim mono">
                  {CLIENT_PROVIDERS[0]?.providerName} · {CLIENT_MODELS.length} models
                </span>
              </div>
              {streaming ? (
                <button type="button" className="btn btn-ghost" onClick={stop}>
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
              <p className="card-title"><Icon name="route" size={15} /> Task plan</p>
              <p className="card-sub">{plan.objective}</p>
              <p className={`badge ${plan.riskClassification === "R0" || plan.riskClassification === "R1" ? "badge-info" : "badge-warning"}`}>
                {plan.riskClassification} · {plan.estimatedComplexity}
              </p>
              <ol className={styles.stageList}>
                {plan.tasks.map((t) => (
                  <li key={t.taskId} className={styles.stageItem}>
                    <span className={styles.stageNum}>{t.taskId.replace("t", "")}</span>
                    <span>{t.description}</span>
                  </li>
                ))}
              </ol>
              {plan.approvalRequirements.length > 0 && (
                <p className={`dim ${styles.mini}`}>Awaiting approval: {plan.approvalRequirements.length} item(s).</p>
              )}
              {plan.unresolvedQuestions.length > 0 && (
                <p className={`dim ${styles.mini}`}>Open questions: {plan.unresolvedQuestions.length}.</p>
              )}
            </section>
          ) : (
            <section className="card">
              <p className="card-title"><Icon name="route" size={15} /> Task plan</p>
              <p className="card-sub">A plan appears when you send a request.</p>
            </section>
          )}

          <section className="card">
            <p className="card-title"><Icon name="activity" size={15} /> Execution receipts</p>
            <p className="card-sub">Governed through the CORE-02 gateway.</p>
            {executions.length === 0 ? (
              <p className="dim" style={{ fontSize: 12 }}>No executions yet.</p>
            ) : (
              <dl className={styles.receipt}>
                {executions.map((e) => (
                  <div key={e.executionId}>
                    <dt className="mono">{e.commandId}</dt>
                    <dd>
                      <span className={`badge ${e.status === "VERIFIED" ? "badge-info" : "badge-warning"}`}>
                        {e.status}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          <section className="card">
            <p className="card-title"><Icon name="shield" size={15} /> Governance</p>
            <p className="card-sub">Model reasons · orchestrator coordinates · gateway governs.</p>
            <div className={styles.sourceRow}>
              <Icon name="check" size={15} />
              <span>Actions execute only through the CORE-02 gateway with passports.</span>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
