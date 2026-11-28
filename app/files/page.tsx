"use client";

import { useState } from "react";
import { PageHeader, DemoNote } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import styles from "./page.module.css";

const FILES = [
  { id: "f1", name: "Weekly-plan.md", kind: "document", size: "12 KB" },
  { id: "f2", name: "Meeting-notes.md", kind: "document", size: "8 KB" },
  { id: "f3", name: "Budget-2026.md", kind: "document", size: "6 KB" },
  { id: "f4", name: "Travel-research.md", kind: "document", size: "15 KB" },
];

const KNOWLEDGE = [
  { id: "k1", name: "Personal preferences", count: "3 notes" },
  { id: "k2", name: "Work contacts", count: "12 entries" },
  { id: "k3", name: "Recipes", count: "8 notes" },
];

export default function FilesPage() {
  const [active, setActive] = useState(FILES[0]);

  return (
    <main className="page">
      <PageHeader
        eyebrow="Files & Knowledge"
        title="Your files and knowledge"
        sub="Your files and notes, scoped to the current workspace. This is a file browser preview."
        icon="files"
      />

      <DemoNote>
        Files and knowledge entries are <strong>demonstration placeholders</strong>. There is no file
        storage or knowledge base connected in this view.
      </DemoNote>

      <div className={`${styles.layout} ${styles.mt}`}>
        <section className="card">
          <p className="card-title"><Icon name="files" size={15} /> Files</p>
          <ul className={styles.list}>
            {FILES.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={`${styles.fileRow} ${active.id === f.id ? styles.fileRowActive : ""}`}
                  onClick={() => setActive(f)}
                >
                  <Icon name="files" size={15} />
                  <span className={styles.fileInfo}>
                    <strong>{f.name}</strong>
                    <span className="dim mono">{f.size}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <p className="card-title"><Icon name="layers" size={15} /> Preview</p>
          <p className="dim">{active.name}</p>
          <div className={styles.preview}>
            <span className="mono">{active.kind} · {active.size}</span>
            <p className="dim">Demonstration preview — no file content is stored or rendered in this view.</p>
          </div>
        </section>

        <section className="card">
          <p className="card-title"><Icon name="agents" size={15} /> Knowledge bases</p>
          <ul className={styles.list}>
            {KNOWLEDGE.map((k) => (
              <li key={k.id}>
                <div className={styles.fileRow}>
                  <Icon name="layers" size={15} />
                  <span className={styles.fileInfo}>
                    <strong>{k.name}</strong>
                    <span className="dim mono">{k.count}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
