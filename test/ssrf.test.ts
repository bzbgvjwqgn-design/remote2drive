import { describe, expect, it } from 'vitest';
import {
  bigIntToIpv4,
  buildPolicy,
  cidrContains,
  classifyIp,
  embeddedIpv4Candidates,
  parseCidr,
  parseIp,
  pinnedLookup,
  resolveSafeTarget,
} from '../src/lib/ssrf.js';
import { TransferError } from '../src/lib/errors.js';

/** Resolves every hostname to a fixed record set, so no test touches real DNS. */
function lookupReturning(records: string[]) {
  return async () => records;
}

async function expectBlocked(rawUrl: string, records: string[] = ['93.184.216.34']) {
  const error = await resolveSafeTarget(rawUrl, {
    policy: buildPolicy(),
    lookup: lookupReturning(records),
  }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(TransferError);
  expect((error as TransferError).code).toBe('SSRF_BLOCKED');
  return error as TransferError;
}

async function captureError(promise: Promise<unknown>): Promise<TransferError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(TransferError);
  return error as TransferError;
}

async function expectInvalid(rawUrl: string, records: string[] = ['93.184.216.34']) {
  const error = await resolveSafeTarget(rawUrl, {
    policy: buildPolicy(),
    lookup: lookupReturning(records),
  }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(TransferError);
  expect((error as TransferError).code).toBe('INVALID_URL');
  return error as TransferError;
}

describe('parseIp', () => {
  it('parses dotted quad into a 32-bit value', () => {
    expect(parseIp('10.1.2.3')).toEqual({ value: 0x0a010203n, family: 4 });
    expect(parseIp('0.0.0.0')).toEqual({ value: 0n, family: 4 });
    expect(parseIp('255.255.255.255')).toEqual({ value: 0xffffffffn, family: 4 });
  });

  it('parses IPv6 including compressed and bracketed forms', () => {
    expect(parseIp('::1')).toEqual({ value: 1n, family: 6 });
    expect(parseIp('[2001:db8::1]')).toEqual({ value: (0x20010db8n << 96n) | 1n, family: 6 });
    expect(parseIp('::ffff:127.0.0.1')?.value).toBe((0xffffn << 32n) | 0x7f000001n);
    expect(parseIp('fe80::1%eth0')).toEqual({ value: (0xfe80n << 112n) | 1n, family: 6 });
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['256.1.1.1', '10.1.1', '010.0.0.1', 'example.com', '', '1:2:3:4:5:6:7:8:9', ':::1']) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });
});

describe('parseCidr / cidrContains', () => {
  it('matches addresses inside the prefix and rejects those outside', () => {
    const ten = parseCidr('10.0.0.0/8');
    expect(ten).not.toBeNull();
    expect(cidrContains(ten!, parseIp('10.255.0.1')!)).toBe(true);
    expect(cidrContains(ten!, parseIp('11.0.0.1')!)).toBe(false);
  });

  it('masks the base address so a non-zero host part still works', () => {
    const cidr = parseCidr('192.168.1.37/24');
    expect(bigIntToIpv4(cidr!.base)).toBe('192.168.1.0');
    expect(cidrContains(cidr!, parseIp('192.168.1.200')!)).toBe(true);
  });

  it('treats /0 as the whole family but never crosses families', () => {
    const all4 = parseCidr('0.0.0.0/0');
    expect(cidrContains(all4!, parseIp('8.8.8.8')!)).toBe(true);
    expect(cidrContains(all4!, parseIp('::1')!)).toBe(false);
  });

  it('handles IPv6 prefixes', () => {
    const ula = parseCidr('fc00::/7');
    expect(cidrContains(ula!, parseIp('fd12:3456::1')!)).toBe(true);
    expect(cidrContains(ula!, parseIp('2001:db8::1')!)).toBe(false);
  });

  it('rejects impossible prefixes', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('::1/129')).toBeNull();
    expect(parseCidr('nope/8')).toBeNull();
  });

  it('defaults to a host route when the prefix is omitted', () => {
    const policy = buildPolicy({ extraAllowed: ['127.0.0.1'] });
    expect(policy.extraAllowed[0]?.mask).toBe(0xffffffffn);
  });
});

describe('embeddedIpv4Candidates', () => {
  it('extracts the IPv4 hidden in IPv4-mapped addresses', () => {
    const ip = parseIp('::ffff:169.254.169.254')!;
    expect(embeddedIpv4Candidates(ip).map(bigIntToIpv4)).toContain('169.254.169.254');
  });

  it('extracts the IPv4 hidden in 6to4 addresses', () => {
    // 2002:7f00:0001:: == 6to4 for 127.0.0.1
    const ip = parseIp('2002:7f00:1::1')!;
    expect(embeddedIpv4Candidates(ip).map(bigIntToIpv4)).toContain('127.0.0.1');
  });

  it('extracts the inverted client IPv4 from a Teredo address', () => {
    // Teredo stores the client address XOR-inverted in the last 32 bits.
    const inverted = (0x7f000001n ^ 0xffffffffn).toString(16).padStart(8, '0');
    const ip = parseIp(`2001:0:0:0:0:0:${inverted.slice(0, 4)}:${inverted.slice(4)}`)!;
    expect(embeddedIpv4Candidates(ip).map(bigIntToIpv4)).toContain('127.0.0.1');
  });

  it('returns nothing for plain IPv4 or ordinary IPv6', () => {
    expect(embeddedIpv4Candidates(parseIp('8.8.8.8')!)).toEqual([]);
    expect(embeddedIpv4Candidates(parseIp('2606:2800::1')!)).toEqual([]);
  });
});

describe('classifyIp', () => {
  const policy = buildPolicy();

  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '2001:db8::1',
  ])('blocks the reserved address %s', (address) => {
    expect(classifyIp(address, policy).blocked).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1', '2606:2800:220:1::1'])(
    'allows the public address %s',
    (address) => {
      expect(classifyIp(address, policy).blocked).toBe(false);
    },
  );

  it('names the offending range so the log line is actionable', () => {
    const verdict = classifyIp('169.254.169.254', policy);
    expect(verdict.matchedCidr).toBe('169.254.0.0/16');
    expect(verdict.reason).toContain('169.254.0.0/16');
  });

  it('blocks an IPv6 form that hides a private IPv4', () => {
    expect(classifyIp('::ffff:192.168.0.1', policy).blocked).toBe(true);
  });

  it('names the embedded address when that is what tripped the rule', () => {
    // With the builtin list disabled, only the operator's range applies — and
    // it must still catch the IPv4 hidden inside the IPv6 form.
    const hardened = buildPolicy({ allowPrivate: true, extraBlocked: ['192.168.0.0/16'] });
    const verdict = classifyIp('::ffff:192.168.0.1', hardened);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('embeds 192.168.0.1');
    expect(verdict.matchedCidr).toBe('192.168.0.0/16');
  });

  it('flags unparseable input rather than failing open', () => {
    expect(classifyIp('not-an-ip', policy).blocked).toBe(true);
  });

  it('honours the operator allowlist ahead of the builtin blocklist', () => {
    const permissive = buildPolicy({ extraAllowed: ['127.0.0.1'] });
    expect(classifyIp('127.0.0.1', permissive).blocked).toBe(false);
    expect(classifyIp('127.0.0.2', permissive).blocked).toBe(true);
  });

  it('honours an extra operator blocklist for public ranges', () => {
    const hardened = buildPolicy({ extraBlocked: ['93.184.216.0/24'] });
    expect(classifyIp('93.184.216.34', hardened).blocked).toBe(true);
    expect(classifyIp('93.184.217.34', hardened).blocked).toBe(false);
  });

  it('lets allowPrivate disable the builtin list (test-only escape hatch)', () => {
    const open = buildPolicy({ allowPrivate: true });
    expect(classifyIp('169.254.169.254', open).blocked).toBe(false);
    // Operator blocklists still apply even then.
    const openButBlocked = buildPolicy({ allowPrivate: true, extraBlocked: ['169.254.169.254'] });
    expect(classifyIp('169.254.169.254', openButBlocked).blocked).toBe(true);
    expect(classifyIp('::ffff:169.254.169.254', openButBlocked).blocked).toBe(true);
    expect(classifyIp('10.0.0.1', openButBlocked).blocked).toBe(false);
  });
});

describe('resolveSafeTarget', () => {
  it('rejects non-http(s) schemes', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'data:text/plain,hi']) {
      const error = await expectInvalid(url);
      expect(error.message, url).toContain('Only http and https');
    }
  });

  it('rejects credentials embedded in the URL', async () => {
    const error = await expectInvalid('http://user:pass@example.com/file.bin');
    expect(error.message).toContain('Credentials');
  });

  it('rejects anything but the configured ports', async () => {
    const error = await expectInvalid('http://example.com:8080/file.bin');
    expect(error.message).toContain('not permitted');
    await expectInvalid('http://example.com:22/x');
  });

  it('accepts explicit 80/443 and fills in the default when absent', async () => {
    const plain = await resolveSafeTarget('http://example.com/a', {
      policy: buildPolicy(),
      lookup: lookupReturning(['93.184.216.34']),
    });
    expect(plain.port).toBe(80);
    expect(plain.protocol).toBe('http:');

    const secure = await resolveSafeTarget('https://example.com:443/a', {
      policy: buildPolicy(),
      lookup: lookupReturning(['93.184.216.34']),
    });
    expect(secure.port).toBe(443);
    expect(secure.protocol).toBe('https:');
  });

  it('blocks literal private hosts without needing DNS', async () => {
    await expectBlocked('http://127.0.0.1/file');
    await expectBlocked('http://10.0.0.5/file');
    await expectBlocked('http://192.168.1.1/file');
    await expectBlocked('http://[::1]/file');
    await expectBlocked('http://[fc00::1]/file');
  });

  it('blocks the cloud metadata endpoint', async () => {
    const error = await expectBlocked('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
    expect(error.userMessage).toContain('blocked network range');
  });

  it('validates every DNS record, not just the first one', async () => {
    // An attacker mixing a public A record with a link-local one must not slip
    // through just because the public record was checked first.
    await expectBlocked('http://mixed.example.com/file', ['93.184.216.34', '169.254.169.254']);
    await expectBlocked('http://mixed.example.com/file', ['169.254.169.254', '93.184.216.34']);
  });

  it('blocks IPv6 transition forms that hide a private IPv4', async () => {
    await expectBlocked('http://v6.example.com/file', ['::ffff:127.0.0.1']);
    await expectBlocked('http://v6.example.com/file', ['2002:7f00:1::1']);
  });

  it('prefers an IPv4 record when the host has both', async () => {
    const target = await resolveSafeTarget('https://dual.example.com/file', {
      policy: buildPolicy(),
      lookup: lookupReturning(['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34']),
    });
    expect(target.address).toBe('93.184.216.34');
    expect(target.family).toBe(4);
    // The hostname is preserved so TLS SNI and certificate checks still work.
    expect(target.hostname).toBe('dual.example.com');
  });

  it('reports a DNS failure as retryable rather than as a policy block', async () => {
    const error = await captureError(
      resolveSafeTarget('http://nx.example.com/file', {
        policy: buildPolicy(),
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    );
    expect(error.code).toBe('SOURCE_UNREACHABLE');
    expect(error.retryable).toBe(true);
  });

  it('treats an empty record set as unreachable', async () => {
    const error = await captureError(
      resolveSafeTarget('http://empty.example.com/file', {
        policy: buildPolicy(),
        lookup: lookupReturning([]),
      }),
    );
    expect(error.code).toBe('SOURCE_UNREACHABLE');
  });

  it('reports a syntactically impossible URL as INVALID_URL', async () => {
    const error = await expectInvalid('http://exa mple.com/');
    expect(error.message).toContain('not a valid URL');
  });
});

describe('pinnedLookup', () => {
  const target = {
    url: new URL('https://example.com/file'),
    hostname: 'example.com',
    address: '93.184.216.34',
    family: 4 as const,
    port: 443,
    protocol: 'https:' as const,
  };

  it('answers the two-argument callback shape with the vetted address', () => {
    const lookup = pinnedLookup(target) as unknown as (host: string, cb: unknown) => void;
    let seen: unknown;
    lookup('example.com', (err: null, address: string, family: number) => {
      seen = { err, address, family };
    });
    expect(seen).toEqual({ err: null, address: '93.184.216.34', family: 4 });
  });

  it('answers the all:true array shape used by autoSelectFamily', () => {
    const lookup = pinnedLookup(target);
    let seen: unknown;
    lookup('example.com', { all: true }, ((err: null, addresses: unknown) => {
      seen = { err, addresses };
    }) as never);
    expect(seen).toEqual({ err: null, addresses: [{ address: '93.184.216.34', family: 4 }] });
  });

  it('answers the options-without-all shape as a single address', () => {
    const lookup = pinnedLookup(target);
    let seen: unknown;
    lookup('example.com', { family: 4 }, ((err: null, address: string, family: number) => {
      seen = { err, address, family };
    }) as never);
    expect(seen).toEqual({ err: null, address: '93.184.216.34', family: 4 });
  });

  it('never returns the name it was asked about', () => {
    const lookup = pinnedLookup({ ...target, address: '8.8.8.8' }) as unknown as (
      host: string,
      cb: unknown,
    ) => void;
    let address = '';
    lookup('attacker.example', (err: null, value: string) => {
      address = value;
    });
    expect(address).toBe('8.8.8.8');
  });
});
