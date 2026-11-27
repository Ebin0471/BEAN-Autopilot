/**
 * CORE-03G — Shared HTTP client for AI provider adapters.
 *
 * A thin, dependency-free wrapper around `fetch` that provides:
 *  - bounded timeouts (AbortController, merged with a caller AbortSignal);
 *  - typed upstream error mapping (401/403/429/5xx/timeout/abort);
 *  - JSON parsing with honest failure classification;
 *  - redirect control (never follows redirects — endpoint safety is enforced
 *    at the base-URL level and a redirect could otherwise bypass it);
 *  - no logging of request/response bodies or credentials.
 *
 * Provider credentials are attached by the adapter as a Bearer header and are
 * never logged, stored, or returned.
 */

export class ProviderHTTPError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number | null,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderHTTPError";
  }
}

export interface HttpRequestOptions {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Parse the response as JSON. Default true for non-streaming calls. */
  json?: boolean;
}

export interface HttpResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Map an HTTP status + body to a typed ProviderHTTPError. */
function toProviderError(
  status: number,
  bodyText: string,
  retryAfterMs: number | null,
): ProviderHTTPError {
  let message = bodyText.slice(0, 300);
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object") {
      message =
        (parsed.error as string) ??
        (parsed.message as string) ??
        (parsed.detail as string) ??
        message;
    }
  } catch {
    /* keep raw slice */
  }
  switch (status) {
    case 401:
      return new ProviderHTTPError(message || "Authentication failed.", "UNAUTHENTICATED", status);
    case 403:
      return new ProviderHTTPError(message || "Forbidden.", "FORBIDDEN", status);
    case 404:
      return new ProviderHTTPError(message || "Not found.", "NOT_FOUND", status);
    case 429:
      return new ProviderHTTPError(
        message || "Rate limited.",
        "RATE_LIMITED",
        status,
        retryAfterMs,
      );
    case 422:
      return new ProviderHTTPError(message || "Validation error.", "VALIDATION_ERROR", status);
    case 502:
      return new ProviderHTTPError(message || "Bad gateway.", "BAD_GATEWAY", status);
    case 503:
      return new ProviderHTTPError(message || "Service unavailable.", "SERVICE_UNAVAILABLE", status);
    case 504:
      return new ProviderHTTPError(message || "Gateway timeout.", "BACKEND_TIMEOUT", status);
    default:
      if (status >= 500) {
        return new ProviderHTTPError(message || `Upstream error (${status}).`, "UPSTREAM_ERROR", status);
      }
      return new ProviderHTTPError(message || `Request failed (${status}).`, "HTTP_ERROR", status);
  }
}

/** Read the Retry-After header (seconds) into milliseconds. */
function retryAfterMsFromHeaders(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (!Number.isNaN(secs) && secs >= 0) return Math.round(secs * 1000);
  return null;
}

/**
 * Perform a non-streaming HTTP request. Returns parsed JSON on 2xx and throws
 * a typed ProviderHTTPError otherwise. Never follows redirects.
 */
export async function httpRequest<T = unknown>(
  options: HttpRequestOptions,
): Promise<HttpResponse<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

  // Merge the caller signal with the timeout.
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutTimer);
      throw new ProviderHTTPError("Request was aborted.", "ABORTED", null);
    }
    options.signal.addEventListener(
      "abort",
      () => controller.abort(),
      { once: true },
    );
  }

  const init: RequestInit = {
    method: options.method,
    headers: {
      accept: "application/json",
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body:
      options.body !== undefined && options.method === "POST"
        ? JSON.stringify(options.body)
        : undefined,
    redirect: "manual",
    signal: controller.signal,
  };

  try {
    const res = await fetch(options.url, init);
    const text = await res.text();

    if (!res.ok) {
      throw toProviderError(res.status, text, retryAfterMsFromHeaders(res.headers));
    }

    const data = (options.json ?? true) ? JSON.parse(text) as T : (text as T);
    return { ok: true, status: res.status, data };
  } catch (e) {
    if (e instanceof ProviderHTTPError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      if (options.signal?.aborted) {
        throw new ProviderHTTPError("Request was aborted by the client.", "ABORTED", null);
      }
      throw new ProviderHTTPError(
        `Request timed out after ${timeoutMs}ms.`,
        "TIMEOUT",
        null,
      );
    }
    throw new ProviderHTTPError(
      e instanceof Error ? e.message : "Network request failed.",
      "NETWORK_ERROR",
      null,
    );
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * Consume an SSE response body as an async iterable of text chunks. Used by
 * the streaming adapters. Throws a typed error for non-2xx responses.
 */
export async function httpSSEStream(
  url: string,
  options: {
    method: "POST";
    headers: Record<string, string>;
    body: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<AsyncIterable<Uint8Array>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutTimer);
      throw new ProviderHTTPError("Request was aborted.", "ABORTED", null);
    }
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: options.method,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(options.body),
      redirect: "manual",
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      clearTimeout(timeoutTimer);
      throw toProviderError(res.status, text, retryAfterMsFromHeaders(res.headers));
    }

    // The timeout bounds only the initial fetch (getting the response). The
    // stream itself is bounded by the caller's AbortSignal and the SSE
    // parser's max-size limit, so we release the timer here.
    clearTimeout(timeoutTimer);

    // Return the raw byte stream; the SSE parser consumes it. Wrap the
    // ReadableStream in an async iterable so it is portable across runtimes.
    const body = res.body;
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        const reader = body.getReader();
        const iterator: AsyncIterator<Uint8Array> = {
          async next(): Promise<IteratorResult<Uint8Array>> {
            const { value, done } = await reader.read();
            if (done) return { value: undefined, done: true };
            return { value, done: false };
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            await reader.cancel().catch(() => undefined);
            return { value: undefined, done: true };
          },
        };
        return iterator;
      },
    };
    return iterable;
  } catch (e) {
    clearTimeout(timeoutTimer);
    if (e instanceof ProviderHTTPError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderHTTPError("Request timed out or was aborted.", "TIMEOUT", null);
    }
    throw new ProviderHTTPError(
      e instanceof Error ? e.message : "Network request failed.",
      "NETWORK_ERROR",
      null,
    );
  }
}
