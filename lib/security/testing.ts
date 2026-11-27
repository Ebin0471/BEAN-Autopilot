import type { Db } from "@/lib/db/database";
import { initDb } from "@/lib/db/database";
import { uuid } from "@/lib/db/util";
import { createServices, type Services } from "./container";
import type { Role, WorkspaceKind } from "./types";

/**
 * TEST-ONLY fixtures. These construct identities and workspaces directly in an
 * isolated in-memory database. They are never exposed as a production
 * authentication bypass — production sign-in is gated by BEAN_DEV_AUTH_ENABLED
 * and requires a real provider identity.
 */

export interface TestEnv {
  db: Db;
  services: Services;
}

export function createTestEnv(): TestEnv {
  const db = initDb(":memory:");
  const services = createServices(db);
  return { db, services };
}

export interface TestUser {
  userId: string;
  token: string;
  sessionId: string;
  workspaceId: string; // private personal workspace
}

export function createTestUser(services: Services, label?: string): TestUser {
  const providerUserId = `test:${uuid()}`;
  const { user } = services.identity.linkAuthAccount("local-test", providerUserId, {
    displayName: label ?? "Test User",
  });
  const workspace = services.workspace.createPersonalWorkspace(user.id);
  const session = services.session.createSession(user.id, "test");
  return {
    userId: user.id,
    token: session.token,
    sessionId: session.sessionId,
    workspaceId: workspace.id,
  };
}

export function createWorkspace(
  services: Services,
  ownerUserId: string,
  kind: WorkspaceKind,
  name: string,
): string {
  return services.workspace.createWorkspace(ownerUserId, kind, name).id;
}

export function addMember(
  services: Services,
  workspaceId: string,
  userId: string,
  role: Role,
  actorId?: string,
): void {
  services.workspace.setMembership(workspaceId, userId, role, actorId ?? workspaceId);
}
