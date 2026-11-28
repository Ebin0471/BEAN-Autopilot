/**
 * CORE-03G.1 — Shared HTTP client for AI provider adapters (pinned SSRF-safe).
 *
 * A thin, dependency-free wrapper around Node's `https`/`http` modules that
 * provides:
 *  - PINNED outbound connections: every request resolves the host, validates
 *    every resolved IP against the endpoint-safety policy, and pins the socket
 *    to the validated IP via a custom lookup (DNS-rebinding protection);
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

import https from "node:https";
import http from "node:http";
import {
  EndpointSafetyError,
  resolveAndValidateHost,
  pinnedLookup,
  defaultEndpointPolicy,
  type EndpointPolicy,
  type PinnedDestination,
} from "./endpoint-safety";

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

/** Resolve a request URL to a pinned, validated destination. */
async function resolvePinnedDestination(
  url: string,
  policy: EndpointPolicy = defaultEndpointPolicy(),
): Promise<PinnedDestination> {
  const parsed = new URL(url);
  const secure = parsed.protocol === "https:";
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
  return resolveAndValidateHost(parsed.hostname, port, secure, policy);
}

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
function retryAfterMsFromHeaders(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers["retry-after"];
  if (!raw) return null;
  const secs = Number(raw);
  if (!Number.isNaN(secs) && secs >= 0) return Math.round(secs * 1000);
  return null;
}

/**
 * Perform a non-streaming HTTP request. Returns parsed JSON on 2xx and throws
 * a typed ProviderHTTPError otherwise. Never follows redirects. The socket is
 * pinned to a DNS-resolved, validated IP (DNS-rebinding protection).
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

  let destination: PinnedDestination;
  try {
    destination = await resolvePinnedDestination(options.url);
  } catch (e) {
    clearTimeout(timeoutTimer);
    if (e instanceof EndpointSafetyError) {
      throw new ProviderHTTPError(e.message, e.code, null);
    }
    throw new ProviderHTTPError(
      e instanceof Error ? e.message : "Network request failed.",
      "NETWORK_ERROR",
      null,
    );
  }

  const parsed = new URL(options.url);
  const lib = destination.secure ? https : http;
  const reqPath = parsed.pathname + parsed.search;

  return new Promise<HttpResponse<T>>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: destination.ip, // pin to validated IP
        port: destination.port,
        path: reqPath,
        method: options.method,
        headers: {
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          host: destination.hostname, // original hostname for virtual hosting
          ...options.headers,
        },
        lookup: pinnedLookup(destination), // pin the socket to the validated IP
        servername: destination.secure ? destination.hostname : undefined, // TLS SNI
        signal: controller.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(toProviderError(res.statusCode ?? 0, text, retryAfterMsFromHeaders(res.headers)));
            return;
          }
          const data = (options.json ?? true) ? JSON.parse(text) as T : (text as T);
          resolve({ ok: true, status: res.statusCode, data });
        });
        res.on("error", (err) => {
          reject(
            new ProviderHTTPError(
              err instanceof Error ? err.message : "Network request failed.",
              "NETWORK_ERROR",
              null,
            ),
          );
        });
      },
    );

    req.on("error", (err) => {
      if (err instanceof Error && err.name === "AbortError") {
        if (options.signal?.aborted) {
          reject(new ProviderHTTPError("Request was aborted by the client.", "ABORTED", null));
        } else {
          reject(new ProviderHTTPError(`Request timed out after ${timeoutMs}ms.`, "TIMEOUT", null));
        }
      } else {
        reject(
          new ProviderHTTPError(
            err instanceof Error ? err.message : "Network request failed.",
            "NETWORK_ERROR",
            null,
          ),
        );
      }
    });

    if (options.body !== undefined && options.method === "POST") {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  }).finally(() => {
    clearTimeout(timeoutTimer);
  });
}

/**
 * Consume an SSE response body as an async iterable of text chunks. Used by
 * the streaming adapters. Throws a typed error for non-2xx responses. The
 * socket is pinned to a DNS-resolved, validated IP (DNS-rebinding protection).
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

  let destination: PinnedDestination;
  try {
    destination = await resolvePinnedDestination(url);
  } catch (e) {
    clearTimeout(timeoutTimer);
    if (e instanceof EndpointSafetyError) {
      throw new ProviderHTTPError(e.message, e.code, null);
    }
    throw new ProviderHTTPError(
      e instanceof Error ? e.message : "Network request failed.",
      "NETWORK_ERROR",
      null,
    );
  }

  const parsed = new URL(url);
  const lib = destination.secure ? https : http;
  const reqPath = parsed.pathname + parsed.search;

  return new Promise<AsyncIterable<Uint8Array>>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: destination.ip,
        port: destination.port,
        path: reqPath,
        method: options.method,
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          host: destination.hostname,
          ...options.headers,
        },
        lookup: pinnedLookup(destination),
        servername: destination.secure ? destination.hostname : undefined,
        signal: controller.signal,
      },
      (res) => {
        // The timeout bounds only the initial request (getting the response).
        // The stream itself is bounded by the caller's AbortSignal and the
        // SSE parser's max-size limit, so we release the timer here.
        clearTimeout(timeoutTimer);

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            reject(toProviderError(res.statusCode ?? 0, text, retryAfterMsFromHeaders(res.headers)));
          });
          res.on("error", () => {
            reject(new ProviderHTTPError("Upstream stream error.", "UPSTREAM_ERROR", res.statusCode ?? null));
          });
          return;
        }

        // Wrap the response stream in an async iterable. We push raw chunks
        // and stop the stream when the consumer finishes or aborts.
        const queue: Uint8Array[] = [];
        let pushResolve: (() => void) | null = null;
        let pushReject: ((e: Error) => void) | null = null;
        let finished = false;

        res.on("data", (c: Buffer) => {
          queue.push(c);
          const r = pushResolve;
          pushResolve = null;
          r?.();
        });
        res.on("error", (err) => {
          finished = true;
          const r = pushReject;
          pushReject = null;
          r?.(err instanceof Error ? err : new Error("Stream error."));
        });
        res.on("close", () => {
          finished = true;
          const r = pushResolve;
          pushResolve = null;
          r?.();
        });

        const iterable: AsyncIterable<Uint8Array> = {
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              async next(): Promise<IteratorResult<Uint8Array>> {
                if (done) return { value: undefined, done: true };
                if (queue.length > 0) {
                  return { value: queue.shift() as Uint8Array, done: false };
                }
                if (finished) return { value: undefined, done: true };
                await new Promise<void>((res2, rej2) => {
                  pushResolve = () => res2();
                  pushReject = (e) => rej2(e);
                });
                if (queue.length > 0) {
                  return { value: queue.shift() as Uint8Array, done: false };
                }
                done = true;
                return { value: undefined, done: true };
              },
              async return(): Promise<IteratorResult<Uint8Array>> {
                done = true;
                try {
                  res.destroy();
                } catch {
                  /* ignore */
                }
                return { value: undefined, done: true };
              },
            };
          },
        };
        resolve(iterable);
      },
    );

    req.on("error", (err) => {
      clearTimeout(timeoutTimer);
      if (err instanceof Error && err.name === "AbortError") {
        reject(new ProviderHTTPError("Request timed out or was aborted.", "TIMEOUT", null));
      } else {
        reject(
          new ProviderHTTPError(
            err instanceof Error ? err.message : "Network request failed.",
            "NETWORK_ERROR",
            null,
          ),
        );
      }
    });

    req.write(JSON.stringify(options.body));
    req.end();
  });
}
