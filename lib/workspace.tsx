"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { WorkspaceKind } from "./types";
import { WORKSPACES } from "./data";

interface WorkspaceCtx {
  workspace: WorkspaceKind;
  setWorkspace: (w: WorkspaceKind) => void;
  workspaceMeta: (typeof WORKSPACES)[number];
}

const Ctx = createContext<WorkspaceCtx | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspace, setWorkspace] = useState<WorkspaceKind>("personal");
  const value = useMemo<WorkspaceCtx>(() => {
    const meta = WORKSPACES.find((w) => w.id === workspace) ?? WORKSPACES[0];
    return { workspace, setWorkspace, workspaceMeta: meta };
  }, [workspace]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
