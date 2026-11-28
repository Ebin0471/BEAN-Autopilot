/**
 * CORE-03G — Robust Server-Sent Events (SSE) parser.
 *
 * Consumes an async stream of text chunks (from a provider's SSE response)
 * and yields normalized events. Handles the real-world hazards of streaming:
 *
 *  - arbitrary network chunk boundaries (a frame may be split across chunks);
 *  - multiple frames within a single chunk;
 *  - CRLF and LF line endings;
 *  - comment / heartbeat frames (lines starting with `:`);
 *  - valid `data:` frames;
 *  - a terminal `done:true` frame;
 *  - typed error frames (with a `partial` flag);
 *  - stream termination without a valid terminal frame (detected, not hidden);
 *  - a maximum response-size bound;
 *  - cooperative cancellation via AbortSignal.
 *
 * The parser NEVER claims successful completion from an incomplete stream.
 */

export interface SSEFrame {
  /** Parsed `data:` payload as a JSON object when valid, else raw text. */
  data: unknown;
  /** Raw data string before parsing. */
  raw: string;
}

export interface SSEStreamResult {
  /** Accumulated delta text from `delta` frames. */
  content: string;
  /** Terminal `done` frame payload, if received. */
  done: Record<string, unknown> | null;
  /** Typed error frame, if received. */
  error: { code: string; message: string; partial: boolean } | null;
  /** True when the stream reached a valid terminal frame (done or error). */
  terminal: boolean;
  /** True when the stream ended WITHOUT a valid terminal frame. */
  truncated: boolean;
  /** Total bytes consumed. */
  bytes: number;
}

export interface SSEParserOptions {
  /** Maximum total response size in bytes (hard bound). */
  maxBytes?: number;
}

/**
 * Parse a single SSE event block (the lines between blank lines). Returns the
 * joined `data:` lines. Handles CRLF by normalising line endings first.
 */
function parseEventBlock(block: string): string | null {
  // Normalise CRLF / CR to LF, then split.
  const lines = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("data:")) {
      // SSE spec: a single optional leading space after the colon is stripped.
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    // event:/id:/retry: are ignored — the BEAN contract uses only data frames.
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

/**
 * Consume a chunked SSE byte stream and produce a complete result.
 *
 * The function is incremental: it buffers partial frames across chunks and only
 * evaluates a frame when a blank line (or stream end) closes the event block.
 */
export async function parseSSEStream(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
  options: SSEParserOptions = {},
): Promise<SSEStreamResult> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024; // 4 MB default bound
  const decoder = new TextDecoder();

  let buffer = "";
  let content = "";
  let done: Record<string, unknown> | null = null;
  let error: SSEStreamResult["error"] = null;
  let bytes = 0;
  let terminal = false;

  const processBlock = (block: string) => {
    const data = parseEventBlock(block);
    if (data == null) return;
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      // Non-JSON data frame: treat the raw text as a delta (some providers
      // send plain text). It is not a terminal event.
      content += data;
      return;
    }
    // Terminal done frame.
    if (obj.done === true) {
      done = obj;
      terminal = true;
      return;
    }
    // Typed error frame.
    if (typeof obj.error === "string") {
      error = {
        code: typeof obj.code === "string" ? obj.code : "SSE_ERROR",
        message: obj.error,
        partial: obj.partial === true,
      };
      terminal = true;
      return;
    }
    // Delta frame.
    if (typeof obj.delta === "string") {
      content += obj.delta;
    }
  };

  for await (const chunk of chunks) {
    if (signal?.aborted) {
      return { content, done, error, terminal, truncated: false, bytes };
    }
    bytes += chunk.length;
    if (bytes > maxBytes) {
      // Enforce the bound: stop consuming and mark truncated.
      return {
        content,
        done,
        error,
        terminal: false,
        truncated: true,
        bytes,
      };
    }
    buffer += decoder.decode(chunk, { stream: true });

    // Split on blank lines (event boundaries). The trailing partial block is
    // kept in the buffer for the next chunk.
    let sepIndex: number;
    while ((sepIndex = findEventSeparator(buffer)) !== -1) {
      const block = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 1);
      processBlock(block);
      if (terminal) {
        return { content, done, error, terminal, truncated: false, bytes };
      }
    }
  }

  // Flush any remaining buffer as a final (possibly incomplete) block.
  if (buffer.trim() !== "") {
    processBlock(buffer);
  }

  return {
    content,
    done,
    error,
    terminal,
    truncated: !terminal,
    bytes,
  };
}

/**
 * Find the index of the blank line that separates an event block, accounting
 * for CRLF. Returns the index of the separator's first newline.
 */
function findEventSeparator(buffer: string): number {
  const normalised = buffer.indexOf("\n\n");
  if (normalised !== -1) return normalised;
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) return crlf;
  return -1;
}

/**
 * A yielded item from the incremental frame iterator.
 *
 * - `{ kind: "data", data }`: a complete `data:` frame's payload (raw string,
 *   before JSON parsing). Yielded as soon as the frame is closed by a blank
 *   line — this is the basis of GENUINE incremental forwarding: deltas reach
 *   the consumer the moment they arrive, not after the whole stream is
 *   buffered.
 * - `{ kind: "truncated" }`: the hard max-size bound was exceeded. Emitted
 *   once, then the iterator ends.
 */
export type SSEFrameYield =
  | { kind: "data"; data: string }
  | { kind: "truncated" };

/**
 * Incrementally iterate the `data:` frames of an SSE byte stream, yielding
 * each frame's raw payload as soon as it is complete.
 *
 * Unlike {@link parseSSEStream} (which buffers the entire response), this
 * generator forwards frames the moment a blank line closes an event block.
 * Adapters use this for genuine incremental SSE forwarding: each delta is
 * relayed to the caller immediately rather than after the full response has
 * been accumulated.
 *
 * Handles: arbitrary chunk boundaries, CRLF/LF, keepalive/comment frames
 * (ignored), and the max-size bound. The caller interprets each frame
 * (BEAN `delta`/`done`/`error` vs OpenAI `choices`/`[DONE]`/`usage`).
 */
export async function* iterateSSEFrames(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
  options: SSEParserOptions = {},
): AsyncGenerator<SSEFrameYield> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const decoder = new TextDecoder();

  let buffer = "";
  let bytes = 0;

  for await (const chunk of chunks) {
    if (signal?.aborted) return;
    bytes += chunk.length;
    if (bytes > maxBytes) {
      // Hard bound exceeded: emit a truncation marker and stop. Any frames
      // already yielded stand as partial content; the response is not
      // trustworthy as complete.
      yield { kind: "truncated" };
      return;
    }
    buffer += decoder.decode(chunk, { stream: true });

    let sepIndex: number;
    while ((sepIndex = findEventSeparator(buffer)) !== -1) {
      const block = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 1);
      const data = parseEventBlock(block);
      if (data != null) {
        yield { kind: "data", data };
      }
    }
  }

  // Flush any trailing partial frame (stream ended without a final blank line).
  if (buffer.trim() !== "") {
    const data = parseEventBlock(buffer);
    if (data != null) {
      yield { kind: "data", data };
    }
  }
}
