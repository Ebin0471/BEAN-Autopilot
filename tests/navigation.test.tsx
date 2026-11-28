import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { Shell } from "@/components/Shell";
import sidebarStyles from "@/components/Sidebar.module.css";
import shellStyles from "@/components/Shell.module.css";

function stubMatchMedia(matches: boolean) {
  return (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

function renderShell() {
  const { container } = render(<Shell>{<div />}</Shell>);
  const menuBtn = within(screen.getByRole("banner")).getByRole("button", {
    name: "Open navigation",
  });
  return { container, menuBtn };
}

function drawerState(container: HTMLElement) {
  const menuBtn = within(screen.getByRole("banner")).getByRole("button", {
    name: /Open navigation|Close navigation/,
  });
  const sidebar = container.querySelector("aside")!;
  const closeButtons = screen.queryAllByRole("button", { name: "Close navigation" });
  return {
    menuBtn,
    open: menuBtn.getAttribute("aria-expanded") === "true",
    sidebarOpen: sidebar.className.includes(sidebarStyles.sidebarOpen),
    overlayPresent: closeButtons.some((b) => b.className.includes(shellStyles.overlay)),
  };
}

describe("App shell navigation", () => {
  beforeEach(() => {
    // Simulate a narrow (mobile) viewport so the drawer behaviour is active.
    window.matchMedia = stubMatchMedia(true) as unknown as typeof window.matchMedia;
  });

  it("renders all primary navigation items", () => {
    render(<Shell>{<div>page content</div>}</Shell>);
    for (const label of [
      "Home",
      "Chat",
      "Agent Workforce",
      "Automation Studio",
      "Connections",
      "Activity & Receipts",
      "Files & Knowledge",
      "Settings",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders the brand and the three workspace options", () => {
    render(<Shell>{<div />}</Shell>);
    expect(screen.getByText(/BEAN/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Personal" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Professional" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Business" })).toBeInTheDocument();
  });

  it("switching workspace updates the visible context indicator", () => {
    render(<Shell>{<div />}</Shell>);
    // default is Personal
    const ctx = () =>
      screen.getByText((_, el) => !!el && el.className.toString().includes("ctxLabel"));
    expect(ctx().textContent).toMatch(/Personal/);
    fireEvent.click(screen.getByRole("radio", { name: "Business" }));
    expect(ctx().textContent).toMatch(/Business/);
    expect(ctx().textContent).not.toMatch(/Personal/);
  });

  it("no longer shows the obsolete UI-01 demo shell marker", () => {
    render(<Shell>{<div />}</Shell>);
    expect(screen.queryByText(/UI-01/i)).not.toBeInTheDocument();
  });

  describe("mobile drawer", () => {
    it("menu button opens the drawer with aria-expanded and the sidebar open class", () => {
      const { container, menuBtn } = renderShell();
      expect(menuBtn).toHaveAttribute("aria-expanded", "false");
      expect(menuBtn).toHaveAttribute("aria-controls", "app-drawer");

      fireEvent.click(menuBtn);
      const state = drawerState(container);
      expect(state.open).toBe(true);
      expect(state.sidebarOpen).toBe(true);
      expect(state.overlayPresent).toBe(true);
      expect(menuBtn).toHaveAttribute("aria-label", "Close navigation");
    });

    it("backdrop click closes the drawer and restores the menu button state", () => {
      const { container, menuBtn } = renderShell();
      fireEvent.click(menuBtn);

      const overlay = screen
        .getAllByRole("button", { name: "Close navigation" })
        .find((b) => b.className.includes(shellStyles.overlay))!;
      expect(overlay).toBeTruthy();
      fireEvent.click(overlay);

      const state = drawerState(container);
      expect(state.open).toBe(false);
      expect(state.sidebarOpen).toBe(false);
      expect(state.overlayPresent).toBe(false);
      expect(menuBtn).toHaveAttribute("aria-expanded", "false");
      expect(menuBtn).toHaveAttribute("aria-label", "Open navigation");
    });

    it("sidebar close button closes the drawer", () => {
      const { container, menuBtn } = renderShell();
      fireEvent.click(menuBtn);

      const closeBtn = screen
        .getAllByRole("button", { name: "Close navigation" })
        .find((b) => b.className.includes(sidebarStyles.closeBtn))!;
      expect(closeBtn).toBeTruthy();
      fireEvent.click(closeBtn);

      const state = drawerState(container);
      expect(state.open).toBe(false);
      expect(state.sidebarOpen).toBe(false);
    });

    it("Escape closes the drawer", () => {
      const { container, menuBtn } = renderShell();
      fireEvent.click(menuBtn);
      expect(drawerState(container).open).toBe(true);

      fireEvent.keyDown(window, { key: "Escape" });
      const state = drawerState(container);
      expect(state.open).toBe(false);
      expect(state.sidebarOpen).toBe(false);
      expect(state.overlayPresent).toBe(false);
    });

    it("keeps the closed drawer out of the tab order on narrow viewports", () => {
      const { container, menuBtn } = renderShell();
      const slot = container.querySelector("aside")!.parentElement as HTMLElement;

      // closed: inert (not focusable / hidden from assistive tech)
      expect(slot.inert).toBe(true);

      fireEvent.click(menuBtn);
      expect(slot.inert).toBe(false);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(slot.inert).toBe(true);
    });

    it("selecting a navigation item closes the drawer", () => {
      const { container, menuBtn } = renderShell();
      fireEvent.click(menuBtn);
      fireEvent.click(screen.getByRole("link", { name: /Automation Studio/ }));

      const state = drawerState(container);
      expect(state.open).toBe(false);
      expect(state.sidebarOpen).toBe(false);
    });
  });
});
