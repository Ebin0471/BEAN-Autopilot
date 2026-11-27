import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { Shell } from "@/components/Shell";

describe("App shell navigation", () => {
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

  it("shows the UI-01 demo shell marker", () => {
    render(<Shell>{<div />}</Shell>);
    expect(screen.getByText(/UI-01 · Demo shell/i)).toBeInTheDocument();
  });
});
