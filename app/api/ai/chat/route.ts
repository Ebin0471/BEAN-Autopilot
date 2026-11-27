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
 * The response is streamed as newline-delimited JSON events:
 *   - meta:       turn metadata (intent task category, status)
 *   - delta:      incremental assistant text
 *   - plan:       the structured proposed plan
 *   - execution:  a command execution receipt (governed)
 *   - complete:   final usage + status
 *   - error:      honest failure
 *
 * No provider credentials reach the browser; no chain-of-thought is exposed.
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
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        const turn = await services.orchestrator.handleTurn({
          workspaceId: body.workspaceId,
          userId: auth.userId,
          conversationId: body.conversationId,
          message: body.message,
          autoExecuteSafe: body.autoExecuteSafe,
        });

        send({
          type: "meta",
          taskCategory: turn.intent.taskCategory,
          language: turn.intent.language,
          requiresClarification: turn.intent.requiresClarification,
          missingInformation: turn.intent.missingInformation,
        });

        // Stream the assistant text in chunks.
        const words = turn.response.split(/(\s+)/);
        for (const chunk of words) {
          if (chunk) send({ type: "delta", delta: chunk });
        }

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

        // Persist the assistant message.
        const assistant = services.conversations.appendMessage({
          conversationId: body.conversationId,
          workspaceId: body.workspaceId,
          userId: auth.userId,
          role: "assistant",
          content: turn.response,
          structured: { plan: turn.plan, executions: turn.executions, limitations: turn.limitations },
          status: "COMPLETED",
        });

        send({
          type: "complete",
          status: turn.status,
          messageId: assistant.id,
          limitations: turn.limitations,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Chat turn failed";
        const code = (e as { code?: string }).code ?? "CHAT_ERROR";
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
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache, no-transform",
    },
  });
}
