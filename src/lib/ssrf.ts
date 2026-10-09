import dns from 'node:dns/promises';
import net from 'node:net';
import { TransferError } from './errors.js';

export type IpFamily = 4 | 6;

export interface Cidr {
  text: string;
  base: bigint;
  mask: bigint;
  family: IpFamily;
}

export interface SsrfPolicy {
  /** Test-only escape hatch. Never true in production. */
  allowPrivate: boolean;
  extraBlocked: Cidr[];
  extraAllowed: Cidr[];
  allowedPorts: number[];
}

export interface ResolvedTarget {
  url: URL;
  hostname: string;
  address: string;
  family: IpFamily;
  port: number;
  protocol: 'http:' | 'https:';
}

const V4_BITS = 32n;
const V6_BITS = 128n;

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

function ipv4ToBigInt(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // Reject "" and octal-style "010": both are ambiguous across resolvers.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function hexGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  for (const group of part.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  return groups;
}

/** Expands any valid IPv6 textual form into its 8 sixteen-bit groups. */
function ipv6Groups(input: string): number[] | null {
  let text = input.trim();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  // Trailing embedded IPv4 ("::ffff:127.0.0.1") becomes two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail);
    if (v4 === null) return null;
    const high = Number((v4 >> 16n) & 0xffffn);
    const low = Number(v4 & 0xffffn);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  let groups: number[];
  if (halves.length === 2) {
    const head = hexGroups(halves[0] ?? '');
    const tailGroups = hexGroups(halves[1] ?? '');
    if (head === null || tailGroups === null) return null;
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tailGroups];
  } else {
    const parsed = hexGroups(halves[0] ?? '');
    if (parsed === null || parsed.length !== 8) return null;
    groups = parsed;
  }
  return groups;
}

function ipv6ToBigInt(text: string): bigint | null {
  const groups = ipv6Groups(text);
  if (groups === null) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

export interface ParsedIp {
  value: bigint;
  family: IpFamily;
}

export function parseIp(text: string): ParsedIp | null {
  const trimmed = text.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(trimmed)) {
    const value = ipv4ToBigInt(trimmed);
    return value === null ? null : { value, family: 4 };
  }
  if (net.isIPv6(trimmed)) {
    const value = ipv6ToBigInt(trimmed);
    return value === null ? null : { value, family: 6 };
  }
  return null;
}

export function bigIntToIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

export function parseCidr(text: string): Cidr | null {
  const [addressPart, prefixPart] = text.trim().split('/');
  if (addressPart === undefined) return null;
  const parsed = parseIp(addressPart);
  if (parsed === null) return null;

  const bits = parsed.family === 4 ? V4_BITS : V6_BITS;
  let prefix = bits;
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    const candidate = BigInt(Number(prefixPart));
    if (candidate < 0n || candidate > bits) return null;
    prefix = candidate;
  }
  const mask = prefix === 0n ? 0n : ((1n << bits) - 1n) ^ ((1n << (bits - prefix)) - 1n);
  return {
    text: text.trim(),
    base: parsed.value & mask,
    mask,
    family: parsed.family,
  };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;
  return (ip.value & cidr.mask) === cidr.base;
}

// ---------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------

const BLOCKED_V4 = [
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // RFC1918
  '100.64.0.0/10', // RFC6598 carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local — includes the 169.254.169.254 metadata endpoint
  '172.16.0.0/12', // RFC1918
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // RFC1918
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
  '255.255.255.255/32', // broadcast
];

const BLOCKED_V6 = [
  '::/128', // unspecified
  '::1/128', // loopback
  '::ffff:0:0/96', // IPv4-mapped (embedded v4 is checked separately)
  '64:ff9b::/96', // NAT64 well-known prefix
  '64:ff9b:1::/48', // NAT64 local-use
  '100::/64', // discard-only
  '2001::/32', // Teredo (embedded v4 is checked separately)
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4 (embedded v4 is checked separately)
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'ff00::/8', // multicast
];

const BUILTIN_BLOCKED: Cidr[] = [...BLOCKED_V4, ...BLOCKED_V6]
  .map((text) => parseCidr(text))
  .filter((cidr): cidr is Cidr => cidr !== null);

/**
 * Transition mechanisms hide an IPv4 address inside an IPv6 one, so blocking
 * the outer prefix is not enough — the embedded address has to be judged too.
 */
export function embeddedIpv4Candidates(ip: ParsedIp): bigint[] {
  if (ip.family !== 6) return [];
  const out: bigint[] = [];
  const v4Mask = 0xffffffffn;

  if ((ip.value >> 32n) === 0xffffn) {
    out.push(ip.value & v4Mask); // ::ffff:a.b.c.d
  }
  if ((ip.value >> 112n) === 0x2002n) {
    out.push((ip.value >> 80n) & v4Mask); // 6to4
  }
  if ((ip.value >> 96n) === 0x20010000n) {
    out.push((ip.value & v4Mask) ^ v4Mask); // Teredo stores the client inverted
  }
  return out;
}

export interface BlockVerdict {
  blocked: boolean;
  reason?: string;
  matchedCidr?: string;
}

export function classifyIp(text: string, policy: SsrfPolicy): BlockVerdict {
  const parsed = parseIp(text);
  if (parsed === null) {
    return { blocked: true, reason: `unparseable address "${text}"` };
  }

  for (const cidr of policy.extraAllowed) {
    if (cidrContains(cidr, parsed)) return { blocked: false, matchedCidr: cidr.text };
  }

  const candidates: ParsedIp[] = [parsed];
  for (const embedded of embeddedIpv4Candidates(parsed)) {
    candidates.push({ value: embedded, family: 4 });
  }

  // Operator blocklists are judged against the embedded address too: with
  // allowPrivate on, "::ffff:169.254.169.254" would otherwise walk straight
  // past an operator's explicit 169.254.169.254 entry.
  const ranges = policy.allowPrivate
    ? policy.extraBlocked
    : [...policy.extraBlocked, ...BUILTIN_BLOCKED];

  for (const candidate of candidates) {
    for (const cidr of ranges) {
      if (!cidrContains(cidr, candidate)) continue;
      const shown = candidate === parsed ? text : `${text} (embeds ${bigIntToIpv4(candidate.value)})`;
      const origin = policy.allowPrivate ? 'the operator-blocked range' : 'the reserved range';
      return {
        blocked: true,
        reason: `${shown} resolves into ${origin} ${cidr.text}`,
        matchedCidr: cidr.text,
      };
    }
  }
  return { blocked: false };
}

export function buildPolicy(options: {
  allowPrivate?: boolean;
  extraBlocked?: string[];
  extraAllowed?: string[];
  allowedPorts?: number[];
} = {}): SsrfPolicy {
  const toCidrs = (list: string[] | undefined): Cidr[] =>
    (list ?? [])
      .map((entry) => parseCidr(entry.includes('/') ? entry : `${entry}/${entry.includes(':') ? 128 : 32}`))
      .filter((cidr): cidr is Cidr => cidr !== null);

  return {
    allowPrivate: options.allowPrivate ?? false,
    extraBlocked: toCidrs(options.extraBlocked),
    extraAllowed: toCidrs(options.extraAllowed),
    allowedPorts: options.allowedPorts ?? [80, 443],
  };
}

// ---------------------------------------------------------------------------
// URL validation + DNS resolution
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  policy: SsrfPolicy;
  /** Injected in tests to avoid real DNS traffic. */
  lookup?: (hostname: string) => Promise<string[]>;
}

function defaultLookup(hostname: string): Promise<string[]> {
  return dns.lookup(hostname, { all: true, verbatim: true }).then((results) => results.map((r) => r.address));
}

function isLiteralHost(hostname: string): boolean {
  return net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
}

/**
 * Validates a URL and resolves its host to a single vetted address.
 *
 * The returned address is what callers must actually connect to. Doing the
 * lookup here — once — and pinning the socket to it closes the DNS-rebinding
 * window between "we checked the name" and "we opened the socket".
 */
export async function resolveSafeTarget(
  rawUrl: string,
  options: ValidateOptions,
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TransferError('INVALID_URL', `"${truncate(rawUrl)}" is not a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TransferError(
      'INVALID_URL',
      `Only http and https URLs are allowed (got "${url.protocol}//")`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new TransferError('INVALID_URL', 'Credentials in the URL are not allowed');
  }
  if (url.hostname === '') {
    throw new TransferError('INVALID_URL', 'URL has no hostname');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || !options.policy.allowedPorts.includes(port)) {
    throw new TransferError(
      'INVALID_URL',
      `Port ${url.port || '(default)'} is not permitted. Allowed: ${options.policy.allowedPorts.join(', ')}`,
    );
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: string[];

  if (isLiteralHost(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await lookup(hostname);
    } catch (cause) {
      throw new TransferError(
        'SOURCE_UNREACHABLE',
        `DNS lookup failed for "${hostname}": ${(cause as Error).message}`,
        { retryable: true, cause },
      );
    }
    if (addresses.length === 0) {
      throw new TransferError('SOURCE_UNREACHABLE', `No DNS records for "${hostname}"`, {
        retryable: true,
      });
    }
  }

  // Every record must pass. Accepting the first good one lets an attacker mix a
  // public A record with a 169.254.169.254 one and wait for us to pick it.
  for (const address of addresses) {
    const verdict = classifyIp(address, options.policy);
    if (verdict.blocked) {
      throw new TransferError(
        'SSRF_BLOCKED',
        `Refusing to contact ${hostname}: ${verdict.reason}`,
        { userMessage: 'That URL points at a blocked network range.' },
      );
    }
  }

  const chosen = pickAddress(addresses);
  const parsedChosen = parseIp(chosen);
  if (parsedChosen === null) {
    throw new TransferError('SOURCE_UNREACHABLE', `Unusable resolved address "${chosen}"`, {
      retryable: true,
    });
  }

  return {
    url,
    hostname,
    address: chosen,
    family: parsedChosen.family,
    port,
    protocol: url.protocol === 'https:' ? 'https:' : 'http:',
  };
}

/** Prefer IPv4: plenty of VPS fleets have no working IPv6 egress route. */
function pickAddress(addresses: string[]): string {
  const v4 = addresses.find((a) => net.isIPv4(a));
  if (v4 !== undefined) return v4;
  return addresses[0] ?? '';
}

export type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void;

/**
 * A `dns.lookup`-shaped function that always returns the pre-vetted address.
 *
 * Node's `net.connect` uses two different callback shapes depending on whether
 * `all` was requested (it is, whenever autoSelectFamily is on), so both are
 * answered here rather than assuming a single form.
 */
export function pinnedLookup(target: ResolvedTarget): PinnedLookup {
  const single = (
    callback: (err: null, address: string, family: number) => void,
  ): void => callback(null, target.address, target.family);

  const many = (
    callback: (err: null, addresses: { address: string; family: number }[]) => void,
  ): void => callback(null, [{ address: target.address, family: target.family }]);

  const lookup = ((
    _hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: unknown,
  ): void => {
    if (typeof optionsOrCallback === 'function') {
      single(optionsOrCallback as (err: null, address: string, family: number) => void);
      return;
    }
    const wantsAll =
      typeof optionsOrCallback === 'object' &&
      optionsOrCallback !== null &&
      (optionsOrCallback as { all?: boolean }).all === true;
    const callback = maybeCallback as
      | ((err: null, address: string | { address: string; family: number }[], family?: number) => void)
      | undefined;
    if (callback === undefined) return;
    if (wantsAll) {
      many(callback as (err: null, addresses: { address: string; family: number }[]) => void);
      return;
    }
    single(callback as (err: null, address: string, family: number) => void);
  }) as PinnedLookup;

  return lookup;
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
