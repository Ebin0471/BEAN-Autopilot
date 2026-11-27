import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import { AuditService } from "@/lib/security/audit";
import type {
  Conversation,
  Message,
  RoutingMode,
  UsageMetadata,
} from "./types";

export class ConversationError extends Error {
  constructor(message: string, public code = "CONVERSATION_ERROR") {
    super(message);
    this.name = "ConversationError";
  }
}

/**
 * Conversation Service.
 *
 * Workspace-scoped, authenticated persistence for conversations and messages.
 * Every query is scoped to (workspace, user): a user cannot retrieve another
 * user's conversation by changing an identifier. Ownership and the workspace
 * relationship are stored explicitly. No unnecessary sensitive data is stored.
 */
export class ConversationService {
  constructor(private db: Db, private audit: AuditService) {}

  create(input: {
    workspaceId: string;
    userId: string;
    title: string;
    selectedModelId?: string | null;
    selectedProviderId?: string | null;
    routingMode?: RoutingMode;
  }): Conversation {
    const id = uuid();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, workspace_id, user_id, title, status, selected_model_id, selected_provider_id, routing_mode, created_at, updated_at)
         VALUES (?,?,?,?, 'ACTIVE', ?,?,?,?,?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.userId,
        input.title,
        input.selectedModelId ?? null,
        input.selectedProviderId ?? null,
        input.routingMode ?? "AUTO",
        ts,
        ts,
      );
    return this.get(id, input.workspaceId, input.userId)!;
  }

  /** Fetch a conversation, enforced to (workspace, user). */
  get(id: string, workspaceId: string, userId: string): Conversation | null {
    const row = this.db
      .prepare(
        "SELECT * FROM conversations WHERE id = ? AND workspace_id = ? AND user_id = ?",
      )
      .get(id, workspaceId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapConversation(row) : null;
  }

  list(workspaceId: string, userId: string): Conversation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM conversations WHERE workspace_id = ? AND user_id = ? AND status != 'DELETED' ORDER BY updated_at DESC",
      )
      .all(workspaceId, userId) as Record<string, unknown>[];
    return rows.map((r) => this.mapConversation(r));
  }

  rename(id: string, workspaceId: string, userId: string, title: string): Conversation {
    const conv = this.get(id, workspaceId, userId);
    if (!conv) throw new ConversationError("Conversation not found", "NOT_FOUND");
    this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, now(), id);
    return this.get(id, workspaceId, userId)!;
  }

  setSelection(
    id: string,
    workspaceId: string,
    userId: string,
    selection: { modelId: string | null; providerId: string | null; routingMode: RoutingMode },
  ): Conversation {
    const conv = this.get(id, workspaceId, userId);
    if (!conv) throw new ConversationError("Conversation not found", "NOT_FOUND");
    this.db
      .prepare(
        "UPDATE conversations SET selected_model_id = ?, selected_provider_id = ?, routing_mode = ?, updated_at = ? WHERE id = ?",
      )
      .run(selection.modelId, selection.providerId, selection.routingMode, now(), id);
    return this.get(id, workspaceId, userId)!;
  }

  delete(id: string, workspaceId: string, userId: string): void {
    const conv = this.get(id, workspaceId, userId);
    if (!conv) throw new ConversationError("Conversation not found", "NOT_FOUND");
    this.db
      .prepare("UPDATE conversations SET status = 'DELETED', updated_at = ? WHERE id = ?")
      .run(now(), id);
  }

  /** Append a message and return it with its sequence number. */
  appendMessage(input: {
    conversationId: string;
    workspaceId: string;
    userId: string;
    role: Message["role"];
    content: string;
    structured?: unknown;
    modelId?: string | null;
    providerId?: string | null;
    usage?: UsageMetadata | null;
    status?: Message["status"];
    errorCode?: string | null;
  }): Message {
    const conv = this.get(input.conversationId, input.workspaceId, input.userId);
    if (!conv) throw new ConversationError("Conversation not found", "NOT_FOUND");
    const nextSeq =
      (this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE conversation_id = ?")
        .get(input.conversationId) as { m: number }).m + 1;
    const id = uuid();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, role, content, content_json, model_id, provider_id, token_usage_json, status, error_code, created_at, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.content,
        input.structured ? JSON.stringify(input.structured) : null,
        input.modelId ?? null,
        input.providerId ?? null,
        input.usage ? JSON.stringify(input.usage) : null,
        input.status ?? "COMPLETED",
        input.errorCode ?? null,
        ts,
        nextSeq,
      );
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(ts, input.conversationId);
    return this.getMessage(id)!;
  }

  /** Mark an in-flight assistant message as failed/cancelled. */
  setMessageStatus(
    messageId: string,
    status: Message["status"],
    errorCode?: string | null,
  ): void {
    this.db
      .prepare("UPDATE messages SET status = ?, error_code = ? WHERE id = ?")
      .run(status, errorCode ?? null, messageId);
  }

  getMessage(id: string): Message | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMessage(row) : null;
  }

  /** Messages for a conversation, enforced to (workspace, user). */
  listMessages(conversationId: string, workspaceId: string, userId: string): Message[] {
    const conv = this.get(conversationId, workspaceId, userId);
    if (!conv) throw new ConversationError("Conversation not found", "NOT_FOUND");
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
      .all(conversationId) as Record<string, unknown>[];
    return rows.map((r) => this.mapMessage(r));
  }

  /** Record AI usage for a workspace (observability, not billing). */
  recordUsage(input: {
    workspaceId: string;
    userId: string;
    providerId: string | null;
    modelId: string | null;
    usage: UsageMetadata;
    latencyMs: number | null;
    conversationId: string | null;
    failure: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage
         (id, workspace_id, user_id, provider_id, model_id, input_tokens, output_tokens, cached_tokens,
          latency_ms, request_count, failure_count, estimated_cost_json, conversation_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,NULL,?,?)`,
      )
      .run(
        uuid(),
        input.workspaceId,
        input.userId,
        input.providerId,
        input.modelId,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cachedTokens,
        input.latencyMs,
        input.failure ? 1 : 0,
        input.conversationId,
        now(),
      );
  }

  listUsage(workspaceId: string, limit = 50): Array<{
    providerId: string | null;
    modelId: string | null;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number | null;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT provider_id, model_id, input_tokens, output_tokens, latency_ms, created_at FROM ai_usage WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      providerId: (r.provider_id as string) ?? null,
      modelId: (r.model_id as string) ?? null,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      latencyMs: (r.latency_ms as number) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  private mapConversation(row: Record<string, unknown>): Conversation {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      userId: row.user_id as string,
      title: row.title as string,
      status: row.status as Conversation["status"],
      selectedModelId: (row.selected_model_id as string) ?? null,
      selectedProviderId: (row.selected_provider_id as string) ?? null,
      routingMode: row.routing_mode as RoutingMode,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapMessage(row: Record<string, unknown>): Message {
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      role: row.role as Message["role"],
      content: row.content as string,
      structured: row.content_json ? JSON.parse(row.content_json as string) : null,
      modelId: (row.model_id as string) ?? null,
      providerId: (row.provider_id as string) ?? null,
      usage: row.token_usage_json ? JSON.parse(row.token_usage_json as string) : null,
      status: row.status as Message["status"],
      errorCode: (row.error_code as string) ?? null,
      createdAt: row.created_at as string,
      seq: row.seq as number,
    };
  }
}
