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

/** Normalise an IP string: strip surrounding brackets and lowercase. */
function normalizeIp(ip: string): string {
  return ip.toLowerCase().replace(/^\[|\]$/g, "");
}

/** Parse an IPv4 dotted-quad into octets, or null when invalid. */
function parseIpv4(s: string): [number, number, number, number] | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets: [number, number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

/**
 * Parse an IPv6 address into 8 16-bit groups, or null when invalid.
 * Handles `::` compression and an embedded IPv4 dotted-quad at the end
 * (e.g. `::ffff:1.2.3.4` or `2001:db8::1.2.3.4`). The embedded IPv4 becomes
 * the final two groups so IPv4-mapped addresses are classified canonically.
 */
function parseIpv6(s: string): number[] | null {
  let str = s;
  let embeddedV4: [number, number, number, number] | null = null;
  const lastDot = s.lastIndexOf(".");
  if (lastDot !== -1) {
    const colon = s.lastIndexOf(":", lastDot - 1);
    if (colon === -1) return null;
    const v4 = parseIpv4(s.slice(colon + 1));
    if (!v4) return null;
    embeddedV4 = v4;
    str = s.slice(0, colon);
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const p of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  const dbl = str.indexOf("::");
  let groups: number[];
  if (dbl !== -1) {
    if (str.indexOf("::", dbl + 1) !== -1) return null;
    const lhs = parseGroups(str.slice(0, dbl));
    const rhs = parseGroups(str.slice(dbl + 2));
    if (!lhs || !rhs) return null;
    const missing = 8 - lhs.length - rhs.length - (embeddedV4 ? 2 : 0);
    if (missing < 0) return null;
    groups = [...lhs, ...new Array<number>(missing).fill(0), ...rhs];
  } else {
    const all = parseGroups(str);
    if (!all) return null;
    groups = all;
  }

  if (embeddedV4) {
    const [a, b, c, d] = embeddedV4;
    groups.push(((a << 8) | b) >>> 0, ((c << 8) | d) >>> 0);
  }
  if (groups.length !== 8) return null;
  return groups;
}

/** A canonically parsed IP address. */
export type ParsedIp =
  | { kind: "v4"; octets: [number, number, number, number] }
  | { kind: "v6"; groups: number[] };

/**
 * Canonical IP parser. Returns null when the value is not a valid IPv4 or
 * IPv6 literal. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is parsed into its 8 IPv6
 * groups so it can be classified by its embedded IPv4.
 */
export function parseIp(value: string): ParsedIp | null {
  const h = normalizeIp(value);
  if (h.includes(":")) {
    const groups = parseIpv6(h);
    if (groups) return { kind: "v6", groups };
    return null;
  }
  const octets = parseIpv4(h);
  if (octets) return { kind: "v4", octets };
  return null;
}

/** Classify an IPv4 octet set as blocked (metadata is unconditional). */
function isBlockedIpv4(
  octets: [number, number, number, number],
  allowLocal: boolean,
): boolean {
  const [a, b] = octets;
  // Metadata IPs: unconditional.
  if (METADATA_IPS.has(octets.join("."))) return true;
  if (a === 127) return allowLocal ? false : true; // loopback
  if (a === 10) return allowLocal ? false : true; // private
  if (a === 172 && b >= 16 && b <= 31) return allowLocal ? false : true; // private
  if (a === 192 && b === 168) return allowLocal ? false : true; // private
  if (a === 169 && b === 254) return allowLocal ? false : true; // link-local
  if (a === 0) return true; // "this host" always blocked
  if (a >= 224) return true; // multicast / reserved always blocked
  return false;
}

/**
 * Classify an IP address (IPv4 or IPv6, no brackets) as blocked using
 * CANONICAL PARSING — no string-prefix checks that can be bypassed through
 * alternate IP notation. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are
 * classified by their embedded IPv4.
 *
 * Metadata IPs are blocked UNCONDITIONALLY (even with local endpoints enabled).
 * Loopback / private / link-local / multicast / reserved ranges are blocked
 * unless `allowLocal` is true (the explicit local-development opt-in).
 */
export function isBlockedIp(ip: string, allowLocal: boolean): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;

  if (parsed.kind === "v4") {
    return isBlockedIpv4(parsed.octets, allowLocal);
  }

  const g = parsed.groups;
  // Unspecified (::) — always blocked.
  if (g.every((x) => x === 0)) return true;
  // Loopback (::1) — always blocked.
  if (g[7] === 1 && g.slice(0, 7).every((x) => x === 0)) return true;
  // Multicast (ff00::/8) — always blocked.
  if ((g[0] & 0xff00) === 0xff00) return true;
  // Link-local (fe80::/10).
  if ((g[0] & 0xffc0) === 0xfe80) return allowLocal ? false : true;
  // Unique-local (fc00::/7).
  if ((g[0] & 0xfe00) === 0xfc00) return allowLocal ? false : true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d):
  // the first five groups are zero; classify by the embedded IPv4.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0xffff || g[5] === 0) {
      const a = g[6] >> 8;
      const b = g[6] & 0xff;
      const c = g[7] >> 8;
      const d = g[7] & 0xff;
      return isBlockedIpv4([a, b, c, d], allowLocal);
    }
  }
  return false;
}

/** True when a string is a valid IPv4 or IPv6 literal (no DNS lookup needed). */
export function isIpLiteral(value: string): boolean {
  return parseIp(value) !== null;
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
 * carries a private/loopback IP (including IPv4-mapped IPv6) is blocked before
 * any DNS lookup.
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
