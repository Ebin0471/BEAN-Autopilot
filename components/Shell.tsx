"use client";

import { useState } from "react";
import { Icon } from "./Icon";
import { Sidebar } from "./Sidebar";
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace";
import styles from "./Shell.module.css";

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { workspaceMeta } = useWorkspace();
  return (
    <header className={styles.topbar}>
      <button
        className={styles.menuBtn}
        onClick={onMenu}
        aria-label="Open navigation"
        type="button"
      >
        <Icon name="menu" size={20} />
      </button>
      <div className={styles.ctx}>
        <span className={styles.ctxDot} />
        <span className={styles.ctxLabel}>
          {workspaceMeta.label} <span className={styles.ctxDim}>workspace</span>
        </span>
      </div>
      <span className={`badge badge-gold ${styles.demoBadge}`}>
        <Icon name="spark" size={13} />
        UI-01 · Demo shell
      </span>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  return (
    <WorkspaceProvider>
      <div className="shell">
        <div className={`${styles.drawerWrap} ${drawer ? styles.open : ""}`}>
          <Sidebar onNavigate={() => setDrawer(false)} />
        </div>
        {drawer && (
          <button
            className={styles.overlay}
            aria-label="Close navigation"
            onClick={() => setDrawer(false)}
            type="button"
          />
        )}
        <div className="app-main">
          <TopBar onMenu={() => setDrawer(true)} />
          <div className={styles.content}>{children}</div>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
