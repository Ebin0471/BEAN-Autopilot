// @vitest-environment jsdom

/**
 * CORE-03G.2 — Finding #3: workspace switching must refresh consent.
 *
 * Verifies that the Settings page loads each workspace's own consent when the
 * selected workspace changes, that stale in-flight responses never overwrite a
 * newer workspace's state, and that consent updates target the currently
 * selected workspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { WorkspaceProvider } from "@/lib/workspace";
import SettingsPage from "@/app/settings/page";

interface WsDef {
  id: string;
  kind: string;
  name: string;
}

interface ConsentDef {
  externalAiAllowed: boolean;
  allowedExternalProviderIds: string[];
  externalAiUsable: boolean;
  consentedAt: string | null;
}

const WORKSPACES: WsDef[] = [
  { id: "ws1", kind: "PERSONAL", name: "Personal" },
  { id: "ws2", kind: "PROFESSIONAL", name: "Professional" },
  { id: "ws3", kind: "BUSINESS", name: "Business" },
];

const PROVIDERS = [
  { providerId: "p1", providerName: "Alpha", adapterType: "test" },
  { providerId: "p2", providerName: "Beta", adapterType: "test" },
];

const CONSENT: Record<string, ConsentDef> = {
  ws1: { externalAiAllowed: true, allowedExternalProviderIds: ["p1"], externalAiUsable: true, consentedAt: "2026-01-01T00:00:00.000Z" },
  ws2: { externalAiAllowed: false, allowedExternalProviderIds: [], externalAiUsable: false, consentedAt: null },
  ws3: { externalAiAllowed: true, allowedExternalProviderIds: ["p2"], externalAiUsable: true, consentedAt: "2026-02-02T00:00:00.000Z" },
};

function wrap(ui: React.ReactElement) {
  return render(<WorkspaceProvider>{ui}</WorkspaceProvider>);
}

describe("CORE-03G.2 — Finding 3: workspace-switching consent refresh", () => {
  let getResolvers: Map<string, () => void>;
  let patchCalls: { url: string; body: Record<string, unknown> }[];
  let getCalls: string[];
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    getResolvers = new Map();
    patchCalls = [];
    getCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  function mockResponse(payload: unknown, ok = true) {
    return { ok, status: ok ? 200 : 500, json: async () => payload };
  }

  function installFetch() {
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return Promise.resolve(mockResponse({ workspaces: WORKSPACES }));
      }
      if (url.startsWith("/api/ai/consent")) {
        const method = init?.method ?? "GET";
        const wsMatch = url.match(/workspaceId=([^&]+)/);
        const wsId = wsMatch ? wsMatch[1] : "";
        if (method === "PATCH") {
          let body = {} as Record<string, unknown>;
          try {
            body = JSON.parse(String(init?.body ?? "{}"));
          } catch {
            /* ignore */
          }
          patchCalls.push({ url, body });
          // Echo back the patched consent (updated allowlist + derived usable).
          const allow = Array.isArray(body.allowedExternalProviderIds)
            ? (body.allowedExternalProviderIds as string[])
            : [];
          const allowed = Boolean(body.externalAiAllowed);
          return Promise.resolve(
            mockResponse({
              consent: {
                externalAiAllowed: allowed,
                allowedExternalProviderIds: allow,
                externalAiUsable: allowed && allow.length > 0,
                consentedAt: new Date().toISOString(),
              },
              providers: PROVIDERS,
            }),
          );
        }
        // GET: deferred per-workspace so tests can control ordering.
        getCalls.push(url);
        return new Promise((resolve) => {
          const resolveOnce = () => {
            const c = CONSENT[wsId] ?? {
              externalAiAllowed: false,
              allowedExternalProviderIds: [],
              externalAiUsable: false,
              consentedAt: null,
            };
            resolve(mockResponse({ consent: c, providers: PROVIDERS }));
          };
          getResolvers.set(wsId, resolveOnce);
        });
      }
      return Promise.resolve(mockResponse({}));
    }) as unknown as typeof fetch;
  }

  /** Resolve the pending GET consent for a workspace id. */
  function resolveGet(wsId: string) {
    const r = getResolvers.get(wsId);
    if (!r) throw new Error(`No pending GET consent for ${wsId}`);
    r();
  }

  it("loads the selected workspace's own consent after switching", async () => {
    installFetch();
    wrap(<SettingsPage />);

    // Default workspace is personal (ws1): load it.
    await waitFor(() => expect(getCalls.some((u) => u.includes("workspaceId=ws1"))).toBe(true));
    resolveGet("ws1");
    await waitFor(() =>
      expect(screen.getByText(/External AI is usable for the allowlisted providers above/)).toBeInTheDocument(),
    );

    // Switch to professional (ws2): a fresh load for ws2 must occur.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "professional" } });
    await waitFor(() => expect(getCalls.some((u) => u.includes("workspaceId=ws2"))).toBe(true));
    resolveGet("ws2");
    await waitFor(() =>
      expect(screen.getByText(/External AI is not usable: consent has not been granted/)).toBeInTheDocument(),
    );
  });

  it("does not let a stale in-flight response overwrite a newer workspace", async () => {
    installFetch();
    wrap(<SettingsPage />);

    // ws1 GET is deferred and never resolves until we explicitly do so.
    await waitFor(() => expect(getCalls.some((u) => u.includes("workspaceId=ws1"))).toBe(true));

    // Switch to ws2 and let its (fast) load complete.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "professional" } });
    await waitFor(() => expect(getCalls.some((u) => u.includes("workspaceId=ws2"))).toBe(true));
    resolveGet("ws2");
    await waitFor(() =>
      expect(screen.getByText(/External AI is not usable: consent has not been granted/)).toBeInTheDocument(),
    );

    // Now the stale ws1 response resolves — it must NOT overwrite ws2 state.
    resolveGet("ws1");
    // Give React time to process; the ws2 "not usable" text must remain.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/External AI is not usable: consent has not been granted/)).toBeInTheDocument();
    expect(screen.queryByText(/External AI is usable for the allowlisted providers above/)).not.toBeInTheDocument();
  });

  it("updates consent for the currently selected workspace only", async () => {
    installFetch();
    wrap(<SettingsPage />);

    await waitFor(() => expect(getCalls.some((u) => u.includes("workspaceId=ws1"))).toBe(true));
    resolveGet("ws1");
    await waitFor(() =>
      expect(screen.getByText(/External AI is usable for the allowlisted providers above/)).toBeInTheDocument(),
    );

    // Switch to business (ws3) and load it.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "business" } });
    await waitFor(() => expect(getCalls.some((u) => u.includes("workspaceId=ws3"))).toBe(true));
    resolveGet("ws3");
    await waitFor(() =>
      expect(screen.getByText(/External AI is usable for the allowlisted providers above/)).toBeInTheDocument(),
    );

    // Toggle the Beta (p2) checkbox off → PATCH must target ws3.
    const beta = screen.getByLabelText(/Beta/);
    expect((beta as HTMLInputElement).checked).toBe(true);
    fireEvent.click(beta);

    await waitFor(() => expect(patchCalls.length).toBe(1));
    expect(patchCalls[0].url).toContain("workspaceId=ws3");
    expect(patchCalls[0].body.allowedExternalProviderIds).toEqual([]);
    expect(patchCalls[0].body.externalAiAllowed).toBe(true);
  });

  it("shows a truthful loading state while consent loads", async () => {
    installFetch();
    wrap(<SettingsPage />);
    await waitFor(() => expect(getCalls.some((u) => u.includes("workspaceId=ws1"))).toBe(true));
    // Before the deferred consent resolves, the page must show loading, not a
    // fabricated/stale value.
    expect(screen.getByText(/Loading consent/i)).toBeInTheDocument();
    resolveGet("ws1");
    await waitFor(() =>
      expect(screen.queryByText(/Loading consent/i)).not.toBeInTheDocument(),
    );
  });
});
