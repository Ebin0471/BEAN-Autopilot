"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { INITIAL_WORKFLOW } from "@/lib/data";
import type { WorkflowNode, WorkflowNodeKind } from "@/lib/types";
import styles from "./page.module.css";

const CANVAS_W = 1040;
const CANVAS_H = 460;

const KIND_META: Record<WorkflowNodeKind, { icon: string; color: string; label: string }> = {
  trigger: { icon: "clock", color: "var(--info)", label: "Trigger" },
  agent: { icon: "agents", color: "var(--gold)", label: "AI agent" },
  condition: { icon: "route", color: "var(--warning)", label: "Condition" },
  action: { icon: "zap", color: "var(--success)", label: "Action" },
  approval: { icon: "shield", color: "var(--danger)", label: "Approval" },
  delay: { icon: "clock", color: "var(--text-dim)", label: "Delay" },
  verify: { icon: "check", color: "var(--info)", label: "Verification" },
  error: { icon: "alert", color: "var(--danger)", label: "Error / recovery" },
};

const PALETTE: { kind: WorkflowNodeKind; title: string }[] = [
  { kind: "trigger", title: "Trigger" },
  { kind: "agent", title: "AI agent" },
  { kind: "condition", title: "Condition" },
  { kind: "action", title: "Action" },
  { kind: "approval", title: "Approval" },
  { kind: "delay", title: "Delay / schedule" },
  { kind: "verify", title: "Verification" },
  { kind: "error", title: "Error & recovery" },
];

interface Conn {
  from: string;
  to: string;
}

const INITIAL_CONNS: Conn[] = [
  { from: "n1", to: "n2" },
  { from: "n2", to: "n3" },
  { from: "n3", to: "n4" },
  { from: "n3", to: "n5" },
  { from: "n4", to: "n6" },
  { from: "n5", to: "n6" },
  { from: "n6", to: "n7" },
];

let idSeq = 100;

export default function AutomationPage() {
  const [nodes, setNodes] = useState<WorkflowNode[]>(INITIAL_WORKFLOW);
  const [conns, setConns] = useState<Conn[]>(INITIAL_CONNS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [status, setStatus] = useState<"unsaved" | "saved" | "testing" | "active">("unsaved");
  const [statusText, setStatusText] = useState("Not saved");

  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  function nodeAnchor(id: string, side: "in" | "out") {
    const n = nodes.find((x) => x.id === id);
    if (!n) return null;
    const w = 200;
    const h = 78;
    return side === "out"
      ? { x: n.x + w, y: n.y + h / 2 }
      : { x: n.x, y: n.y + h / 2 };
  }

  function addNode(kind: WorkflowNodeKind) {
    const id = `n${++idSeq}`;
    const meta = KIND_META[kind];
    const node: WorkflowNode = {
      id,
      kind,
      title: meta.label,
      x: 240 + ((idSeq * 40) % 200),
      y: 120 + ((idSeq * 30) % 240),
      note: meta.label,
    };
    setNodes((ns) => [...ns, node]);
    setSelectedId(id);
    setStatus("unsaved");
    setStatusText("Not saved");
  }

  function onNodePointerDown(e: React.PointerEvent, id: string) {
    if (connectFrom) {
      if (connectFrom !== id) {
        setConns((cs) => [...cs, { from: connectFrom, to: id }]);
        setConnectFrom(null);
      }
      return;
    }
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = rect.width / CANVAS_W;
    drag.current = {
      id,
      dx: (e.clientX - rect.left) / scale - n.x,
      dy: (e.clientY - rect.top) / scale - n.y,
    };
    setSelectedId(id);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  useEffect(() => {
    function move(e: PointerEvent) {
      const d = drag.current;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!d || !rect) return;
      const scale = rect.width / CANVAS_W;
      const nx = (e.clientX - rect.left) / scale - d.dx;
      const ny = (e.clientY - rect.top) / scale - d.dy;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === d.id
            ? { ...n, x: Math.max(0, Math.min(CANVAS_W - 200, nx)), y: Math.max(0, Math.min(CANVAS_H - 78, ny)) }
            : n,
        ),
      );
    }
    function up() {
      drag.current = null;
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  function updateSelected(patch: Partial<WorkflowNode>) {
    if (!selectedId) return;
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, ...patch } : n)));
    setStatus("unsaved");
    setStatusText("Not saved");
  }

  function act(kind: "save" | "test" | "activate") {
    if (kind === "save") {
      setStatus("saved");
      setStatusText("Saved — draft only");
    } else if (kind === "test") {
      setStatus("testing");
      setStatusText("Test run — UI simulation only");
      setTimeout(() => setStatusText("Test complete (no backend execution)"), 1400);
    } else {
      setStatus("active");
      setStatusText("Activated — UI state only, not live");
    }
  }

  return (
    <main className="page">
      <PageHeader
        eyebrow="Automation Studio"
        title="Node-based workflow editor"
        sub="Describe a workflow in chat, or build and modify it visually. UI-01 delivers the visual editor shell and basic interactions — production automation execution is not implemented."
        icon="automation"
      />

      <DemoNote>
        The canvas, nodes and connections are a <strong>visual editor shell</strong>. Save, test and
        activate are UI state changes only — no workflow is executed by any backend.
      </DemoNote>

      <div className={styles.layout}>
        {/* palette */}
        <aside className={styles.palette}>
          <p className="field-label">Node palette</p>
          <div className={styles.paletteGrid}>
            {PALETTE.map((p) => (
              <button key={p.kind} type="button" className={styles.paletteBtn} onClick={() => addNode(p.kind)}>
                <Icon name={KIND_META[p.kind].icon} size={15} />
                {p.title}
              </button>
            ))}
          </div>
          <hr className="divider" />
          <p className="field-label">Workflow state</p>
          <span className={`badge ${status === "active" ? "badge-success" : status === "saved" ? "badge-info" : "badge-warning"}`}>
            <span className="badge-dot" />
            {statusText}
          </span>
          <div className={styles.paletteActions}>
            <button type="button" className="btn btn-sm" onClick={() => act("save")}>Save</button>
            <button type="button" className="btn btn-sm" onClick={() => act("test")}>Test</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => act("activate")}>Activate</button>
          </div>
          {connectFrom && <p className={styles.connectHint}>Connect mode: click a target node.</p>}
        </aside>

        {/* canvas */}
        <section className={styles.canvasWrap}>
          <div
            ref={canvasRef}
            className={styles.canvas}
            style={{ width: CANVAS_W, height: CANVAS_H }}
            onPointerDown={() => {
              setSelectedId(null);
              setConnectFrom(null);
            }}
          >
            <svg className={styles.wires} viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}>
              {conns.map((c, i) => {
                const a = nodeAnchor(c.from, "out");
                const b = nodeAnchor(c.to, "in");
                if (!a || !b) return null;
                const mid = (a.x + b.x) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`}
                    fill="none"
                    stroke="rgba(201,169,106,0.45)"
                    strokeWidth={1.6}
                  />
                );
              })}
            </svg>
            {nodes.map((n) => {
              const meta = KIND_META[n.kind];
              const isSel = n.id === selectedId;
              return (
                <div
                  key={n.id}
                  className={`${styles.node} ${isSel ? styles.nodeSel : ""}`}
                  style={{ left: n.x, top: n.y, borderColor: meta.color }}
                  onPointerDown={(e) => onNodePointerDown(e, n.id)}
                >
                  <div className={styles.nodeHead} style={{ color: meta.color }}>
                    <Icon name={meta.icon} size={14} />
                    <span className={styles.nodeKind}>{meta.label}</span>
                    <button
                      type="button"
                      className={styles.nodeLink}
                      aria-label="Start connection"
                      title="Click, then click a target node"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setConnectFrom(n.id);
                      }}
                    >
                      <Icon name="plus" size={13} />
                    </button>
                  </div>
                  <div className={styles.nodeTitle}>{n.title}</div>
                  <div className={styles.nodeNote}>{n.note}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* properties */}
        <aside className={styles.props}>
          <div className="card">
            <p className="card-title"><Icon name="settings" size={15} /> Node properties</p>
            {selected ? (
              <div className="stack">
                <div>
                  <label className="field-label">Title</label>
                  <input className="input" value={selected.title} onChange={(e) => updateSelected({ title: e.target.value })} />
                </div>
                <div>
                  <label className="field-label">Note</label>
                  <input className="input" value={selected.note} onChange={(e) => updateSelected({ note: e.target.value })} />
                </div>
                <div className={styles.propMeta}>
                  <span className="badge">{KIND_META[selected.kind].label}</span>
                  <span className="badge badge-gold">{selected.id}</span>
                </div>
                <p className={`dim ${styles.mini}`}>Drag nodes on the canvas. Click the + on a node to connect it to another.</p>
              </div>
            ) : (
              <p className="dim">Select a node to edit its properties.</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
