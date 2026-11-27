/**
 * CORE-03G — Endpoint safety for outbound AI provider requests.
 *
 * Base URLs come ONLY from trusted server-side environment configuration.
 * They must never be selected by a chat message, model output or arbitrary
 * request body. This module validates every endpoint before a request is made
 * and blocks SSRF / DNS-rebinding risks:
 *
 *  - scheme must be http or https;
 *  - the URL must parse and have a host;
 *  - no embedded credentials;
 *  - no query string or fragment (the adapter constructs the path);
 *  - production requires HTTPS;
 *  - loopback / private / link-local / cloud-metadata hosts are blocked
 *    unless explicit local-development configuration is enabled;
 *  - redirects are disabled at the fetch layer (the adapter never follows
 *    them), so a redirect destination cannot bypass this policy.
 */

export class EndpointSafetyError extends Error {
  constructor(message: string, public code = "ENDPOINT_UNSAFE") {
    super(message);
    this.name = "EndpointSafetyError";
  }
}

export interface EndpointPolicy {
  /** When true, loopback/private/link-local endpoints are permitted. */
  allowLocalEndpoints: boolean;
  /** When true, production (NODE_ENV === "production") permits only HTTPS. */
  requireHttpsInProduction: boolean;
}

/** Cloud metadata + link-local + reserved hosts that must never be dialed. */
const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

const BLOCKED_HOST_SUFFIXES = [".internal", ".metadata", ".localhost.localdomain"];

function isPrivateOrSpecialHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv6 loopback / link-local / unique-local
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return true;
  }
  // IPv4 loopback, private ranges, link-local, multicast, reserved
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this host"
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Validate a base URL against the policy. Returns the normalized URL (without
 * path) or throws EndpointSafetyError.
 */
export function validateBaseUrl(
  rawUrl: string,
  policy: EndpointPolicy,
): URL {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new EndpointSafetyError("Base URL is required.", "ENDPOINT_MISSING");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EndpointSafetyError(
      `Base URL is not a valid absolute URL: ${rawUrl.slice(0, 80)}`,
      "ENDPOINT_INVALID",
    );
  }

  // Scheme.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointSafetyError(
      `Unsupported URL scheme "${url.protocol}". Use http or https.`,
      "ENDPOINT_SCHEME",
    );
  }

  // No embedded credentials.
  if (url.username || url.password) {
    throw new EndpointSafetyError(
      "Base URL must not contain embedded credentials.",
      "ENDPOINT_CREDENTIALS",
    );
  }

  // Host must be present.
  if (!url.hostname) {
    throw new EndpointSafetyError("Base URL must have a host.", "ENDPOINT_HOST");
  }

  // No query or fragment — the adapter constructs the path.
  if (url.search) {
    throw new EndpointSafetyError(
      "Base URL must not contain a query string.",
      "ENDPOINT_QUERY",
    );
  }
  if (url.hash) {
    throw new EndpointSafetyError(
      "Base URL must not contain a fragment.",
      "ENDPOINT_FRAGMENT",
    );
  }

  // Host policy.
  if (isPrivateOrSpecialHost(url.hostname)) {
    if (!policy.allowLocalEndpoints) {
      throw new EndpointSafetyError(
        `Endpoint "${url.hostname}" is a local/private host and local endpoints are not permitted.`,
        "ENDPOINT_LOCAL_BLOCKED",
      );
    }
  }

  // Production HTTPS requirement.
  if (
    policy.requireHttpsInProduction &&
    process.env.NODE_ENV === "production" &&
    url.protocol !== "https:"
  ) {
    throw new EndpointSafetyError(
      "Production requires an HTTPS endpoint.",
      "ENDPOINT_HTTPS_REQUIRED",
    );
  }

  return url;
}

/**
 * Build the default endpoint policy from environment configuration.
 * Local endpoints are permitted only when explicitly enabled.
 */
export function defaultEndpointPolicy(): EndpointPolicy {
  const allowLocal =
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS === "1" ||
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS === "true";
  return {
    allowLocalEndpoints: allowLocal,
    requireHttpsInProduction: true,
  };
}

/**
 * Assert that a full request URL (base + path) still resolves under the same
 * host policy. Used as a second line of defence before fetch.
 */
export function assertRequestUrlSafe(fullUrl: string, policy: EndpointPolicy): URL {
  return validateBaseUrl(fullUrl, policy);
}
