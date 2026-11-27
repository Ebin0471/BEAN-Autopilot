import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import { AuditService } from "./audit";

export interface User {
  id: string;
  email: string | null;
  display_name: string | null;
  status: string;
  email_verified: number;
  created_at: string;
  updated_at: string;
}

export interface AuthAccount {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  created_at: string;
}

/**
 * Provider-neutral identity service. Accounts are linked by a stable
 * (provider, provider_user_id) identity — never by an unverified email alone.
 */
export class IdentityService {
  constructor(private db: Db, private audit: AuditService) {}

  createUser(input: { email?: string | null; displayName?: string | null }): User {
    const id = uuid();
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO users (id, email, display_name, status, email_verified, created_at, updated_at) VALUES (?,?,?, 'ACTIVE', 0, ?, ?)",
      )
      .run(id, input.email ?? null, input.displayName ?? null, ts, ts);
    return this.getUser(id)!;
  }

  /**
   * Find or create a user for a provider identity. If the provider identity is
   * already linked, return the existing user. New identities create a user and
   * a personal workspace is created by the caller (WorkspaceService).
   */
  linkAuthAccount(provider: string, providerUserId: string, input: {
    email?: string | null;
    displayName?: string | null;
  }): { user: User; account: AuthAccount; created: boolean } {
    const existing = this.db
      .prepare("SELECT * FROM auth_accounts WHERE provider = ? AND provider_user_id = ?")
      .get(provider, providerUserId) as AuthAccount | undefined;
    if (existing) {
      return { user: this.getUser(existing.user_id)!, account: existing, created: false };
    }
    const user = this.createUser(input);
    const account: AuthAccount = {
      id: uuid(),
      user_id: user.id,
      provider,
      provider_user_id: providerUserId,
      created_at: now(),
    };
    this.db
      .prepare(
        "INSERT INTO auth_accounts (id, user_id, provider, provider_user_id, created_at) VALUES (?,?,?,?,?)",
      )
      .run(account.id, account.user_id, account.provider, account.provider_user_id, account.created_at);
    this.audit.append({
      workspaceId: user.id, // identity-scoped audit until a workspace exists
      actorId: user.id,
      actorType: "USER",
      eventType: "AUTH_ACCOUNT_LINKED",
      result: "SUCCESS",
      metadata: { provider },
    });
    return { user, account, created: true };
  }

  getUser(id: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
  }

  setUserStatus(id: string, status: string): void {
    this.db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  }

  listAuthAccounts(userId: string): AuthAccount[] {
    return this.db
      .prepare("SELECT * FROM auth_accounts WHERE user_id = ?")
      .all(userId) as unknown as AuthAccount[];
  }
}
