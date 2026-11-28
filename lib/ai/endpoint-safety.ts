/**
 * CORE-03G.1 — Endpoint safety for outbound AI provider requests (hardened).
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
 *  - cloud-metadata IPs are blocked UNCONDITIONALLY — never permitted, even
 *    when local endpoints are enabled;
 *  - loopback / private / link-local hosts are blocked unless explicit
 *    local-development configuration is enabled;
 *  - the actual outbound connection is PINNED to a DNS-resolved, validated
 *    destination via a custom lookup (see resolveAndValidateHost). This
 *    closes the DNS-rebinding window: the IP validated at resolution time is
 *    the IP the socket connects to.
 *  - redirects are disabled at the request layer (the adapter never follows
 *    them), so a redirect destination cannot bypass this policy.
 *
 * DNS-rebinding protection: connections are pinned to the validated IP
 * returned by resolveAndValidateHost, so a hostname that resolves to a
 * blocked IP at connection time is rejected. This is enforced, not merely
 * documented.
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

/** Cloud-metadata IPs that must NEVER be dialed, regardless of policy. */
const METADATA_IPS = new Set([
  "169.254.169.254", // AWS / GCP / Azure IMDS
  "169.254.170.2", // AWS ECS task metadata
  "169.254.170.23", // AWS ECS credential endpoint
  "100.100.100.200", // Alibaba Cloud metadata
  "169.254.169.253", // Azure IMDS (some regions)
]);

/** Cloud-metadata hostnames that must NEVER be dialed, regardless of policy. */
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "metadata.azure.com",
]);

const METADATA_HOST_SUFFIXES = [".internal", ".metadata", ".localhost.localdomain"];

/**
 * Classify an IP address (IPv4 or IPv6, no brackets) as blocked.
 *
 * Metadata IPs are blocked UNCONDITIONALLY. Loopback / private / link-local /
 * multicast / reserved ranges are blocked unless `allowLocal` is true (the
 * explicit local-development opt-in).
 */
export function isBlockedIp(ip: string, allowLocal: boolean): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv6 loopback / link-local / unique-local / multicast.
  if (h === "::1" || h === "::" || h.startsWith("ff")) {
    return true; // loopback + multicast always blocked
  }
  if (h.startsWith("fe80:")) return allowLocal ? false : true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return allowLocal ? false : true; // ULA

  // IPv4.
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    // Metadata IPs: unconditional.
    if (METADATA_IPS.has(h)) return true;
    if (a === 127) return allowLocal ? false : true; // loopback
    if (a === 10) return allowLocal ? false : true; // private
    if (a === 172 && b >= 16 && b <= 31) return allowLocal ? false : true; // private
    if (a === 192 && b === 168) return allowLocal ? false : true; // private
    if (a === 169 && b === 254) return allowLocal ? false : true; // link-local
    if (a === 0) return true; // "this host" always blocked
    if (a >= 224) return true; // multicast / reserved always blocked
    return false;
  }
  return false;
}

/** True when a hostname is a cloud-metadata host (unconditional block). */
export function isMetadataHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (METADATA_HOSTS.has(h)) return true;
  for (const suffix of METADATA_HOST_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Validate a hostname (pre-DNS): reject metadata hostnames unconditionally,
 * and reject loopback/private hosts (by name or IP literal) unless local
 * endpoints are allowed. IP literals are validated here so a base URL that
 * carries a private/loopback IP is blocked before any DNS lookup.
 */
export function isBlockedHostname(hostname: string, allowLocal: boolean): boolean {
  if (isMetadataHost(hostname)) return true; // unconditional
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return allowLocal ? false : true;
  if (h === "0.0.0.0") return true;
  // IP literal in the hostname: apply IP-level classification.
  if (isIpLiteral(h)) return isBlockedIp(h, allowLocal);
  return false;
}

/** True when a string is an IPv4 or IPv6 literal (no DNS lookup needed). */
export function isIpLiteral(value: string): boolean {
  const h = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) {
    // IPv6 literal (contains at least one colon and is hex/colon).
    return /^[0-9a-f:]+$/.test(h) && h.includes(":");
  }
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);
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

  // Host policy. Metadata hostnames are blocked unconditionally.
  if (isBlockedHostname(url.hostname, policy.allowLocalEndpoints)) {
    throw new EndpointSafetyError(
      `Endpoint "${url.hostname}" is a blocked (metadata or local) host.`,
      "ENDPOINT_LOCAL_BLOCKED",
    );
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
 * host policy. Used as a second line of defence before a request.
 */
export function assertRequestUrlSafe(fullUrl: string, policy: EndpointPolicy): URL {
  return validateBaseUrl(fullUrl, policy);
}

/** A validated, pinned outbound destination. */
export interface PinnedDestination {
  /** The hostname from the URL (used for TLS SNI and the Host header). */
  hostname: string;
  /** The IP the socket will connect to (validated). */
  ip: string;
  /** The port. */
  port: number;
  /** True when the scheme is https. */
  secure: boolean;
}

/**
 * Resolve a hostname to IPs and validate EVERY returned IP against the policy.
 *
 * Metadata IPs are rejected unconditionally. If local endpoints are not
 * permitted, loopback/private/link-local IPs are rejected too. Returns a
 * PinnedDestination pinning the socket to the first validated IP.
 *
 * This is the DNS-rebinding defence: the IP returned here is the IP the
 * connection is pinned to. A hostname that resolves to a blocked IP at
 * connection time is rejected before the socket is opened.
 */
export async function resolveAndValidateHost(
  hostname: string,
  port: number,
  secure: boolean,
  policy: EndpointPolicy,
): Promise<PinnedDestination> {
  const { lookup } = await import("node:dns/promises");

  let addresses: string[];
  try {
    const result = await lookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch (e) {
    throw new EndpointSafetyError(
      `Could not resolve host "${hostname}": ${e instanceof Error ? e.message : "DNS failure"}`,
      "ENDPOINT_DNS_FAILURE",
    );
  }

  if (addresses.length === 0) {
    throw new EndpointSafetyError(
      `Host "${hostname}" resolved to no addresses.`,
      "ENDPOINT_DNS_FAILURE",
    );
  }

  // Validate every address. Reject if ANY resolves to a blocked IP.
  for (const ip of addresses) {
    if (isBlockedIp(ip, policy.allowLocalEndpoints)) {
      throw new EndpointSafetyError(
        `Host "${hostname}" resolved to a blocked address (${ip}).`,
        "ENDPOINT_IP_BLOCKED",
      );
    }
  }

  // Pin to the first validated address.
  return { hostname, ip: addresses[0], port, secure };
}

/**
 * Build a custom DNS lookup function that pins a connection to a pre-validated
 * destination. Used by the pinned HTTP client so the socket connects to the
 * validated IP, closing the DNS-rebinding window.
 */
export function pinnedLookup(
  destination: PinnedDestination,
): (
  hostname: string,
  options: import("node:dns").LookupOptions,
  callback: (err: Error | null, address: string, family: number) => void,
) => void {
  return (_hostname, _options, callback) => {
    // Always return the validated IP, regardless of what the caller asks.
    const family = destination.ip.includes(":") ? 6 : 4;
    callback(null, destination.ip, family);
  };
}
