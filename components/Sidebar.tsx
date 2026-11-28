"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";
import { useWorkspace } from "@/lib/workspace";
import { NAV_ITEMS, WORKSPACES } from "@/lib/data";
import type { WorkspaceKind } from "@/lib/types";
import styles from "./Sidebar.module.css";

export function Sidebar({
  open,
  onNavigate,
}: {
  open?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { workspace, setWorkspace } = useWorkspace();

  return (
    <aside
      className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`}
      aria-label="Primary navigation"
    >
      <div className={styles.brand}>
        <span className={styles.logoMark}>
          <Icon name="bean" size={20} strokeWidth={1.7} />
        </span>
        <span className={styles.brandText}>
          <strong>BEAN</strong> Autopilot
        </span>
        {onNavigate && (
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onNavigate}
            aria-label="Close navigation"
          >
            <Icon name="x" size={18} />
          </button>
        )}
      </div>

      <div className={styles.workspaceBlock}>
        <span className={styles.workspaceLabel}>Workspace</span>
        <div className={styles.workspaceSwitch} role="radiogroup" aria-label="Workspace">
          {WORKSPACES.map((w) => (
            <button
              key={w.id}
              role="radio"
              aria-checked={workspace === w.id}
              className={`${styles.wsBtn} ${workspace === w.id ? styles.wsBtnActive : ""}`}
              onClick={() => {
                setWorkspace(w.id as WorkspaceKind);
                onNavigate?.();
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
        <span className={styles.workspaceBlurb}>
          {WORKSPACES.find((w) => w.id === workspace)?.blurb}
        </span>
      </div>

      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const active = item.key === "home" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.key}
              href={item.href}
              onClick={onNavigate}
              className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className={styles.foot}>
        <span className={styles.footTag}>Frontend demo</span>
        <span className={styles.footNote}>No backend execution in this view</span>
      </div>
    </aside>
  );
}
