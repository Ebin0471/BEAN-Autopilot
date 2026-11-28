import { getServices } from "@/lib/security/container";
import { error, requireAuth, unauthorized } from "@/lib/api/http";
import { z } from "zod";
import type { CommandOutcome } from "@/lib/commands/gateway";

export const dynamic = "force-dynamic";

const ChatSchema = z.object({
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  message: z.string().min(1).max(8000),
  autoExecuteSafe: z.boolean().optional(),
});

/**
 * POST /api/ai/chat — send a message and stream the governed AI response.
 *
 * The orchestrator understands intent, assembles context, proposes a plan and
 * executes only permitted, approval-free commands through the CORE-02 gateway.
 * The final assistant response is streamed TRUE from the upstream AI provider's
 * SSE stream (when a real provider is configured); otherwise the honest
 * template response is streamed. The response is streamed as newline-delimited
 * JSON events:
 *   - meta:       turn metadata (intent task category, status)
 *   - delta:      incremental assistant text (true upstream streaming)
 *   - plan:       the structured proposed plan
 *   - execution:  a command execution receipt (governed)
 *   - complete:   final usage + truthful status
 *   - error:      honest failure
 *
 * End-to-end cancellation: if the client disconnects mid-stream, the upstream
 * request is aborted and the assistant message is persisted with a truthful
 * CANCELLED / PARTIAL / FAILED / COMPLETED lifecycle status. No fabricated
 * COMPLETED is recorded for a stream that did not finish.
 *
 * No provider credentials reach the browser; no chain-of-thought is exposed.
 * External-AI workspace consent is enforced server-side before any external
 * provider is used (fail-closed).
 */
export async function POST(req: Request) {
  const services = getServices();
  const auth = requireAuth(services);
  if (!auth) return unauthorized();

  const parsed = ChatSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid chat request", 400);
  const body = parsed.data;

  // Verify workspace membership + conversation ownership (deny-by-default).
  try {
    services.policy.requireMember(auth.userId, body.workspaceId);
  } catch {
    return error("Forbidden", 403);
  }
  const conversation = services.conversations.get(
    body.conversationId,
    body.workspaceId,
    auth.userId,
  );
  if (!conversation) return error("Conversation not found", 404);

  // External-AI consent is enforced inside the orchestrator, per-provider,
  // before any EXTERNAL provider is called (fail-closed). A purely-internal
  // turn is never blocked by this; an external turn without consent is honestly
  // reported as a limitation rather than silently failing.

  // Persist the user message.
  services.conversations.appendMessage({
    conversationId: body.conversationId,
    workspaceId: body.workspaceId,
    userId: auth.userId,
    role: "user",
    content: body.message,
    status: "COMPLETED",
  });

  const encoder = new TextEncoder();
  // AbortController for end-to-end cancellation: client disconnect aborts the
  // in-flight upstream stream so no resources leak and no fabricated COMPLETED
  // is recorded.
  const controller = new AbortController();
  let clientCancelled = false;

  const stream = new ReadableStream({
    async start(streamController) {
      const send = (event: Record<string, unknown>) => {
        streamController.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        const turn = await services.orchestrator.handleTurn(
          {
            workspaceId: body.workspaceId,
            userId: auth.userId,
            conversationId: body.conversationId,
            message: body.message,
            autoExecuteSafe: body.autoExecuteSafe,
          },
          {
            // TRUE upstream streaming: relay provider deltas as they arrive.
            streamResponse: true,
            onResponseDelta: (delta: string) => send({ type: "delta", delta }),
            signal: controller.signal,
          },
        );

        send({
          type: "meta",
          taskCategory: turn.intent.taskCategory,
          language: turn.intent.language,
          requiresClarification: turn.intent.requiresClarification,
          missingInformation: turn.intent.missingInformation,
        });

        send({ type: "plan", plan: turn.plan });

        for (const exec of turn.executions as CommandOutcome[]) {
          send({
            type: "execution",
            executionId: exec.executionId,
            commandId: exec.commandId,
            status: exec.status,
            passportId: exec.passportId,
            errorCode: exec.errorCode,
          });
        }

        // Persist the assistant message with a TRUTHFUL lifecycle status.
        const messageStatus =
          clientCancelled || turn.streamStatus === "CANCELLED"
            ? "CANCELLED"
            : turn.streamStatus === "PARTIAL"
              ? "PARTIAL"
              : "COMPLETED";

        const assistant = services.conversations.appendMessage({
          conversationId: body.conversationId,
          workspaceId: body.workspaceId,
          userId: auth.userId,
          role: "assistant",
          content: turn.response,
          structured: { plan: turn.plan, executions: turn.executions, limitations: turn.limitations },
          status: messageStatus,
        });

        send({
          type: "complete",
          status: messageStatus,
          messageId: assistant.id,
          limitations: turn.limitations,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Chat turn failed";
        const code = (e as { code?: string }).code ?? "CHAT_ERROR";
        if (clientCancelled || controller.signal.aborted) {
          services.conversations.appendMessage({
            conversationId: body.conversationId,
            workspaceId: body.workspaceId,
            userId: auth.userId,
            role: "assistant",
            content: "",
            status: "CANCELLED",
            errorCode: "CLIENT_CANCELLED",
          });
          send({ type: "error", code: "CANCELLED", message: "Response was cancelled." });
        } else {
          services.conversations.appendMessage({
            conversationId: body.conversationId,
            workspaceId: body.workspaceId,
            userId: auth.userId,
            role: "assistant",
            content: `I could not complete this turn: ${msg}`,
            status: "FAILED",
            errorCode: code,
          });
          send({ type: "error", code, message: msg });
        }
      } finally {
        try {
          streamController.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // Client disconnected: abort the in-flight upstream stream and mark the
      // turn cancelled so the persisted message is truthful.
      clientCancelled = true;
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache, no-transform",
    },
  });
}
