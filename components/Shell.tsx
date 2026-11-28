"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Sidebar } from "./Sidebar";
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace";
import styles from "./Shell.module.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const DRAWER_QUERY = "(max-width: 860px)";

function TopBar({ onMenu, drawerOpen }: { onMenu: () => void; drawerOpen: boolean }) {
  const { workspaceMeta } = useWorkspace();
  return (
    <header className={styles.topbar}>
      <button
        className={styles.menuBtn}
        onClick={onMenu}
        aria-expanded={drawerOpen}
        aria-controls="app-drawer"
        aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
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
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  // True on phone/tablet widths where the sidebar is a slide-in drawer.
  const [isNarrow, setIsNarrow] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const sidebarSlotRef = useRef<HTMLDivElement>(null);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DRAWER_QUERY);
    const update = () => setIsNarrow(mq.matches);
    update();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    // Safari < 14 fallback
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  // When the drawer is closed on a narrow viewport, keep the off-screen
  // sidebar out of the tab order and hidden from assistive tech.
  useEffect(() => {
    const slot = sidebarSlotRef.current;
    if (slot) slot.inert = isNarrow && !drawer;
  }, [isNarrow, drawer]);

  // Modal drawer behaviour: Escape closes, Tab cycles inside, background
  // scrolling is locked, and focus returns to the menu button on close.
  useEffect(() => {
    if (!drawer) return;
    const container = drawerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables[0] ?? container).focus?.();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDrawer();
        return;
      }
      if (e.key === "Tab" && focusables.length > 0) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [drawer, closeDrawer]);

  return (
    <WorkspaceProvider>
      <div className="shell">
        <div ref={drawerRef} id="app-drawer" className={styles.drawerWrap}>
          <div ref={sidebarSlotRef} className={styles.sidebarSlot}>
            <Sidebar open={drawer} onNavigate={closeDrawer} />
          </div>
          {drawer && (
            <button
              className={styles.overlay}
              aria-label="Close navigation"
              onClick={closeDrawer}
              type="button"
            />
          )}
        </div>
        <div className="app-main">
          <TopBar onMenu={() => setDrawer(true)} drawerOpen={drawer} />
          <div className={styles.content}>{children}</div>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
