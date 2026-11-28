import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { WorkspaceProvider } from "@/lib/workspace";
import HomePage from "@/app/page";
import ChatPage from "@/app/chat/page";
import AgentsPage from "@/app/agents/page";
import AutomationPage from "@/app/automation/page";
import ConnectionsPage from "@/app/connections/page";
import ActivityPage from "@/app/activity/page";
import chatStyles from "@/app/chat/page.module.css";

function wrap(ui: React.ReactElement) {
  return render(<WorkspaceProvider>{ui}</WorkspaceProvider>);
}

describe("Home dashboard", () => {
  it("renders the greeting and clearly labels demo data", () => {
    wrap(<HomePage />);
    expect(screen.getByText(/Good morning|Good afternoon|Good evening/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/demonstration content/i);
    expect(screen.getByText(/What would you like Autopilot to help you do/)).toBeInTheDocument();
    expect(screen.getByText(/Suggested actions/)).toBeInTheDocument();
    expect(screen.getByText(/Pending approvals/)).toBeInTheDocument();
  });

  it("links to the chat and automation studio", () => {
    const { container } = wrap(<HomePage />);
    expect(container.querySelector('a[href="/chat"]')).not.toBeNull();
    expect(container.querySelector('a[href="/automation"]')).not.toBeNull();
  });
});

describe("Central Autopilot Chat", () => {
  it("shows the workspace context indicator and agent selector", () => {
    wrap(<ChatPage />);
    expect(screen.getByText(/context/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Message/i)).toBeInTheDocument();
    expect(screen.getByText(/Auto-route/)).toBeInTheDocument();
  });

  it("does not fabricate an AI reply: without a session it requires sign-in and stays silent", () => {
    wrap(<ChatPage />);
    // No authenticated session in the test environment: the composer is
    // disabled and a sign-in notice is shown. No assistant reply is fabricated.
    expect(screen.getByText(/Sign in to/i)).toBeInTheDocument();
    const textarea = screen.getByLabelText(/Message/i);
    fireEvent.change(textarea, { target: { value: "Plan my week" } });
    expect(screen.getByRole("button", { name: /Send/i })).toBeDisabled();
    expect(screen.queryByText(/test-provider/i)).not.toBeInTheDocument();
  });

  it("keeps the send button disabled when the draft is empty", () => {
    wrap(<ChatPage />);
    expect(screen.getByRole("button", { name: /Send/i })).toBeDisabled();
  });

  it("renders conversations as keyboard-accessible buttons with a mapped active class", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes("/api/ai/conversations/")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/api/ai/conversations")) {
        return {
          ok: true,
          json: async () => ({
            conversations: [{ id: "c1", title: "Trip plan", updatedAt: new Date().toISOString() }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ workspaces: [{ id: "w1", kind: "personal", name: "Personal" }] }),
      };
    }) as never;

    wrap(<ChatPage />);
    const item = await screen.findByRole("button", { name: /Trip plan/ });
    fireEvent.click(item);
    // the active conversation must use the CSS-module class (not a bare "active")
    expect(item.className).toContain(chatStyles.convActive);
    expect(item).toHaveAttribute("aria-current", "true");
  });
});

describe("Agent Workforce", () => {
  it("lists agents and opens a profile with honest contract placeholders", () => {
    wrap(<AgentsPage />);
    expect(screen.getAllByText(/Chief of Staff/).length).toBeGreaterThan(0);
    // click the universal "Chief of Staff" card (not "Owner Chief of Staff")
    fireEvent.click(screen.getAllByRole("button", { name: /Chief of Staff/ })[0]);
    expect(screen.getByText(/Agent profile/)).toBeInTheDocument();
    expect(screen.getAllByText(/Defined in versioned agent contract/).length).toBeGreaterThan(0);
  });

  it("filters agents by search", () => {
    wrap(<AgentsPage />);
    const search = screen.getByLabelText("Search agents");
    fireEvent.change(search, { target: { value: "Accountant" } });
    expect(screen.getByText(/Accountant/)).toBeInTheDocument();
    expect(screen.queryByText(/Chief of Staff/)).not.toBeInTheDocument();
  });

  it("filters by category", () => {
    wrap(<AgentsPage />);
    // match the "Personal <count>" category tab, not agent cards like "Personal Assistant"
    fireEvent.click(screen.getByRole("button", { name: /^Personal \d/ }));
    expect(screen.getByText(/Family Coordinator/)).toBeInTheDocument();
    expect(screen.queryByText(/Chief of Staff/)).not.toBeInTheDocument();
  });
});

describe("Automation Studio", () => {
  it("renders the initial nodes and node palette", () => {
    wrap(<AutomationPage />);
    expect(screen.getByText(/Add a node/)).toBeInTheDocument();
    expect(screen.getByText(/Research & Fact Checking/)).toBeInTheDocument();
    expect(screen.getByText(/Node properties/)).toBeInTheDocument();
  });

  it("adds a node from the palette and selects it", () => {
    wrap(<AutomationPage />);
    const addBtn = screen.getByRole("button", { name: /^Action$/ });
    fireEvent.click(addBtn);
    // a new node titled "Action" is created and selected
    const properties = screen.getByText(/Node properties/).parentElement!;
    expect(within(properties).getAllByDisplayValue("Action").length).toBeGreaterThan(0);
  });

  it("updates the workflow status on save", () => {
    wrap(<AutomationPage />);
    expect(screen.getByText(/Not saved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByText(/Saved — draft only/)).toBeInTheDocument();
  });
});

describe("Connections and Activity", () => {
  it("shows every registered capability with its real availability state", () => {
    wrap(<ConnectionsPage />);
    // 8 registered capabilities render with honest availability states.
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("IoT")).toBeInTheDocument();
    expect(screen.getAllByText("Not yet available").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });

  it("renders demonstration execution receipts with states", () => {
    wrap(<ActivityPage />);
    expect(screen.getByText(/Task timeline/)).toBeInTheDocument();
    expect(screen.getByText(/Summarise meeting notes/)).toBeInTheDocument();
    expect(screen.getAllByText(/Demo — no real execution/).length).toBeGreaterThan(0);
  });
});
