"use client";

import { useMemo, useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { AGENTS } from "@/lib/data";
import { COMMAND_CATALOGUE } from "@/lib/commands/catalogue";
import type { Agent, AgentStatus } from "@/lib/types";
import styles from "./page.module.css";

const STATUS_META: Record<AgentStatus, { cls: string; label: string }> = {
  planned: { cls: "badge-warning", label: "Planned" },
  configured: { cls: "badge-info", label: "Configured" },
  available: { cls: "badge-gold", label: "Available" },
  active: { cls: "badge-success", label: "Active" },
};

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "universal", label: "Universal" },
  { id: "personal", label: "Personal" },
  { id: "professional", label: "Professional" },
  { id: "business", label: "Business" },
] as const;

const CATEGORY_LABEL: Record<Agent["category"], string> = {
  universal: "Universal",
  personal: "Personal",
  professional: "Professional",
  business: "Business",
};

export default function AgentsPage() {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]["id"]>("all");
  const [selected, setSelected] = useState<Agent | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return AGENTS.filter((a) => {
      const matchesCat = cat === "all" || a.category === cat;
      const matchesQ = !q || a.name.toLowerCase().includes(q) || a.oneLiner.toLowerCase().includes(q);
      return matchesCat && matchesQ;
    });
  }, [query, cat]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: AGENTS.length };
    for (const a of AGENTS) c[a.category] = (c[a.category] ?? 0) + 1;
    return c;
  }, []);

  return (
    <main className="page">
      <PageHeader
        eyebrow="Agent Workforce"
        title="Agent discovery"
        sub="Browse the documented agent roster. Every agent here is planned only — no agent runtime or contract has been imported yet."
        icon="agents"
      />

      <DemoNote>
        All {AGENTS.length} shown agents are <strong>planned</strong>. CORE-02 provides the real registered
        command catalogue ({COMMAND_CATALOGUE.length} commands) and capability fabric that agents will eventually
        use, but no agent runtime exists. No agent is configured, available or active — agents become available
        only with registration and health evidence in a later milestone.
      </DemoNote>

      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Icon name="search" size={16} />
          <input
            className="input"
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search agents"
          />
        </div>
        <div className={styles.cats}>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`${styles.catBtn} ${cat === c.id ? styles.catBtnActive : ""}`}
              onClick={() => setCat(c.id)}
            >
              {c.label} <span className="dim mono">{counts[c.id] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.grid}>
          {filtered.map((a) => {
            const meta = STATUS_META[a.status];
            return (
              <button
                key={a.id}
                type="button"
                className={styles.agentCard}
                onClick={() => setSelected(a)}
              >
                <div className="row-between">
                  <strong className={styles.agentName}>{a.name}</strong>
                  <span className={`badge ${meta.cls}`}><span className="badge-dot" />{meta.label}</span>
                </div>
                <p className={styles.agentLiner}>{a.oneLiner}</p>
                <div className={styles.agentMeta}>
                  <span className="badge">{CATEGORY_LABEL[a.category]}</span>
                  <span className="badge badge-gold">{a.riskClass}</span>
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && <p className="dim">No agents match your search.</p>}
        </div>

        {selected && (
          <aside className={styles.detail}>
            <div className="card">
              <div className="row-between">
                <p className="card-title" style={{ marginBottom: 0 }}>Agent profile</p>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)} aria-label="Close">
                  <Icon name="x" size={14} />
                </button>
              </div>
              <hr className="divider" />
              <h2 className={styles.detailName}>{selected.name}</h2>
              <p className={styles.detailLiner}>{selected.oneLiner}</p>
              <div className={styles.detailBadges}>
                <span className={`badge ${STATUS_META[selected.status].cls}`}>{STATUS_META[selected.status].label}</span>
                <span className="badge">{CATEGORY_LABEL[selected.category]}</span>
                <span className="badge badge-gold">Risk {selected.riskClass}</span>
              </div>

              <dl className={styles.detailList}>
                <div><dt>Responsibilities</dt><dd>{selected.oneLiner}</dd></div>
                <div><dt>Available capabilities</dt><dd className="dim">Defined in versioned agent contract — pending import</dd></div>
                <div><dt>Required permissions</dt><dd className="dim">Defined in versioned agent contract — pending import</dd></div>
                <div><dt>Approval policy</dt><dd>{selected.approval}</dd></div>
                <div><dt>Connection requirements</dt><dd>{selected.connections.length ? selected.connections.join(", ") : "None declared"}</dd></div>
                <div><dt>Status</dt><dd>{STATUS_META[selected.status].label} — not implemented</dd></div>
              </dl>
              <p className={`dim ${styles.mini}`}>
                This profile is a documented placeholder. It makes no claim of licence, capability or execution.
              </p>
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
