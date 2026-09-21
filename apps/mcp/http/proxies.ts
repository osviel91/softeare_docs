/**
 * Trusted-proxy resolution (Phase 6 §49).
 *
 * `X-Forwarded-For`, `X-Forwarded-Proto` and `Forwarded` are client-controlled
 * strings unless the request arrived from a proxy this deployment has named. A
 * service that believes them unconditionally can be told its own address, its
 * own protocol, or another client's address — which corrupts logs, rate limits
 * and any URL built from them.
 *
 * The rule here is therefore the strict one: forwarded information is used only
 * when the socket address is in the configured trust list, and only the
 * *left-most* entry of `X-Forwarded-For` is taken as the client (the part the
 * nearest trusted proxy appended). Everything else falls back to the socket
 * address.
 *
 * The trust list accepts exact addresses (`10.0.0.7`) and IPv4 CIDR ranges
 * (`10.0.0.0/8`, `172.16.0.0/12`). IPv6 is matched exactly; a comment in the
 * parser says so rather than pretending a half-implementation is complete.
 */

/** Whether `value` is a dotted-quad IPv4 address. */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/** Whether an IPv4 address falls inside a CIDR block. */
function ipv4InCidr(address: number[], cidr: string): boolean {
  const [network, bitsRaw] = cidr.split("/");
  const networkOctets = parseIpv4(network);
  if (networkOctets === null) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (octets: number[]) =>
    octets.reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(address) & mask) === (toInt(networkOctets) & mask);
}

/**
 * Whether an address is in the trusted list.
 *
 * `"*"` is deliberately not accepted: "trust everything" is the same as having
 * no check, and a deployment that wants that should also want to be told it is
 * doing something unsafe.
 */
export function isTrustedProxy(
  address: string | undefined,
  trusted: readonly string[],
): boolean {
  if (address === undefined) return false;
  const normalized = address.replace(/^::ffff:/, "");
  for (const entry of trusted) {
    if (entry === normalized) return true;
    if (entry.includes("/")) {
      const octets = parseIpv4(normalized);
      if (octets !== null && ipv4InCidr(octets, entry)) return true;
    }
  }
  return false;
}

/**
 * The client address for logs and rate-limit keys.
 *
 * Returns the socket address unless the socket is a trusted proxy *and* the
 * request carries a forwarded chain, in which case the left-most entry is the
 * client the proxy saw. A malformed chain falls back to the socket address
 * rather than inventing one.
 */
export function clientAddressOf(
  socketAddress: string | undefined,
  headers: Readonly<Record<string, string>>,
  trusted: readonly string[],
): string | undefined {
  if (!isTrustedProxy(socketAddress, trusted)) return socketAddress;
  const forwarded = headers["x-forwarded-for"];
  if (forwarded === undefined) return socketAddress;
  const first = forwarded.split(",")[0]?.trim();
  return first === undefined || first === "" ? socketAddress : first;
}

/** Whether a `Host` header is acceptable, given the configured allow-list. */
export function hostAllowed(
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) return true;
  if (host === undefined) return false;
  return allowed.some((entry) => entry.toLowerCase() === host.toLowerCase());
}
