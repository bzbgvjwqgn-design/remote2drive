import { describe, expect, it } from 'vitest';
import {
  dedupeCandidates,
  extensionForMimeType,
  nameFromUrl,
  nextAvailableName,
  parseContentDisposition,
  pickFileName,
  sanitizeFileName,
  splitName,
} from '../src/lib/filename.js';

describe('parseContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(parseContentDisposition('attachment; filename="report.pdf"')).toBe('report.pdf');
    expect(parseContentDisposition('attachment; filename="report.pdf"; size=123')).toBe('report.pdf');
  });

  it('unescapes backslash sequences inside a quoted filename', () => {
    expect(parseContentDisposition('attachment; filename="a\\"b.txt"')).toBe('a"b.txt');
    expect(parseContentDisposition('attachment; filename="a\\\\b.txt"')).toBe('a\\b.txt');
  });

  it('reads a bare filename', () => {
    expect(parseContentDisposition('attachment; filename=plain.txt')).toBe('plain.txt');
  });

  it('prefers the RFC 6266 extended parameter and decodes it as UTF-8', () => {
    const header = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E2%82%AC%20rates.pdf";
    expect(parseContentDisposition(header)).toBe('€ rates.pdf');
  });

  it('falls back to the plain parameter when the extended one is not UTF-8', () => {
    const header = "attachment; filename=\"fallback.pdf\"; filename*=ISO-8859-1''caf%E9.pdf";
    expect(parseContentDisposition(header)).toBe('fallback.pdf');
  });

  it('falls back when the extended value is not valid percent-encoding', () => {
    const header = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E2%82.pdf";
    expect(parseContentDisposition(header)).toBe('fallback.pdf');
  });

  it('returns null when there is no usable filename', () => {
    expect(parseContentDisposition(null)).toBeNull();
    expect(parseContentDisposition(undefined)).toBeNull();
    expect(parseContentDisposition('')).toBeNull();
    expect(parseContentDisposition('inline')).toBeNull();
    expect(parseContentDisposition('attachment; size=123')).toBeNull();
  });

  it('is case-insensitive about the parameter names', () => {
    expect(parseContentDisposition('Attachment; FileName="MixedCase.zip"')).toBe('MixedCase.zip');
  });
});

describe('sanitizeFileName', () => {
  it('strips directory components using either separator', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(sanitizeFileName('/absolute/path/movie.mp4')).toBe('movie.mp4');
    expect(sanitizeFileName('mixed/path\\..\\..\\name.txt')).toBe('name.txt');
  });

  it('never yields a traversal-only name', () => {
    expect(sanitizeFileName('..')).toBe('download');
    expect(sanitizeFileName('.')).toBe('download');
    expect(sanitizeFileName('...')).toBe('download');
    expect(sanitizeFileName('')).toBe('download');
    expect(sanitizeFileName('   ')).toBe('download');
  });

  it('removes control characters', () => {
    expect(sanitizeFileName('evil\u0000name\u001b[x].txt')).toBe('evilname[x].txt');
    expect(sanitizeFileName('bell\u0007.txt')).toBe('bell.txt');
  });

  it('replaces the characters Drive and Windows reject', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*.txt')).toBe('a_b_c_d_e_f_g_.txt');
  });

  it('collapses whitespace and trims stray dots', () => {
    expect(sanitizeFileName('  my   file.mp4 ')).toBe('my file.mp4');
    expect(sanitizeFileName('..hidden..')).toBe('hidden');
  });

  it('normalizes unicode to NFC', () => {
    const decomposed = 'cafe\u0301.mp4';
    expect(sanitizeFileName(decomposed)).toBe('caf\u00e9.mp4');
  });

  it('truncates long names while keeping the extension', () => {
    const long = `${'a'.repeat(300)}.mp4`;
    const result = sanitizeFileName(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('.mp4')).toBe(true);
  });

  it('truncates a long name with no usable extension to exactly the limit', () => {
    const result = sanitizeFileName('b'.repeat(500));
    expect(result).toBe('b'.repeat(200));
  });

  it('leaves an ordinary name untouched', () => {
    expect(sanitizeFileName('Ubuntu 24.04 Live Server.iso')).toBe('Ubuntu 24.04 Live Server.iso');
  });
});

describe('extensionForMimeType', () => {
  it('maps known types', () => {
    expect(extensionForMimeType('video/mp4')).toBe('.mp4');
    expect(extensionForMimeType('application/pdf')).toBe('.pdf');
    expect(extensionForMimeType('image/jpeg')).toBe('.jpg');
  });

  it('ignores parameters and case', () => {
    expect(extensionForMimeType('text/plain; charset=utf-8')).toBe('.txt');
    expect(extensionForMimeType('VIDEO/MP4')).toBe('.mp4');
  });

  it('returns nothing for unknown or missing types', () => {
    expect(extensionForMimeType('application/octet-stream')).toBe('');
    expect(extensionForMimeType('application/x-unknown-thing')).toBe('');
    expect(extensionForMimeType(null)).toBe('');
    expect(extensionForMimeType(undefined)).toBe('');
  });
});

describe('nameFromUrl', () => {
  it('takes and decodes the last path segment', () => {
    expect(nameFromUrl('https://cdn.example.com/files/My%20Video.mp4?token=abc')).toBe('My Video.mp4');
    expect(nameFromUrl('https://cdn.example.com/a/b/report.pdf')).toBe('report.pdf');
  });

  it('returns null when the URL carries no usable name', () => {
    expect(nameFromUrl('https://example.com/')).toBeNull();
    expect(nameFromUrl('https://example.com')).toBeNull();
    expect(nameFromUrl('not a url')).toBeNull();
  });

  it('keeps percent-encoded oddities from escaping into the name', () => {
    expect(nameFromUrl('https://example.com/%2e%2e%2fetc%2fpasswd')).toBe('passwd');
  });
});

describe('pickFileName', () => {
  const url = 'https://cdn.example.com/downloads/blob';
  /** A URL whose path carries no usable name at all. */
  const nameless = 'https://cdn.example.com/';

  it('prefers the name the user typed', () => {
    expect(
      pickFileName({
        userSupplied: 'mine.mp4',
        contentDisposition: 'attachment; filename="theirs.mp4"',
        contentType: 'video/mp4',
        url: 'https://example.com/from-url.mp4',
      }),
    ).toBe('mine.mp4');
  });

  it('falls back to Content-Disposition', () => {
    expect(
      pickFileName({
        contentDisposition: 'attachment; filename="theirs.mp4"',
        contentType: 'video/mp4',
        url: 'https://example.com/from-url.mp4',
      }),
    ).toBe('theirs.mp4');
  });

  it('falls back to the URL path', () => {
    expect(pickFileName({ contentType: 'video/mp4', url: 'https://example.com/from-url.mp4' })).toBe(
      'from-url.mp4',
    );
    expect(pickFileName({ contentType: 'application/octet-stream', url })).toBe('blob');
  });

  it('falls back to a generic name when nothing else is usable', () => {
    expect(pickFileName({ url: nameless })).toBe('download');
  });

  it('appends an extension implied by the Content-Type when the name has none', () => {
    expect(pickFileName({ contentType: 'video/mp4', url: nameless })).toBe('download.mp4');
    expect(pickFileName({ contentType: 'video/mp4', url })).toBe('blob.mp4');
    expect(
      pickFileName({ contentDisposition: 'attachment; filename="archive"', contentType: 'application/zip', url }),
    ).toBe('archive.zip');
  });

  it('does not double up an extension the name already has', () => {
    expect(pickFileName({ contentType: 'video/mp4', url: 'https://example.com/clip.mp4' })).toBe('clip.mp4');
  });

  it('sanitizes a hostile user-supplied name', () => {
    expect(pickFileName({ userSupplied: '../../etc/passwd', url })).toBe('passwd');
  });

  it('skips a candidate that sanitizes down to nothing', () => {
    expect(
      pickFileName({
        userSupplied: '..',
        contentDisposition: 'attachment; filename="real.pdf"',
        url: 'https://example.com/x',
      }),
    ).toBe('real.pdf');
  });
});

describe('splitName', () => {
  it('separates base and extension', () => {
    expect(splitName('archive.tar.gz')).toEqual({ base: 'archive.tar', extension: '.gz' });
    expect(splitName('movie.mp4')).toEqual({ base: 'movie', extension: '.mp4' });
  });

  it('treats a leading or trailing dot as no extension', () => {
    expect(splitName('.bashrc')).toEqual({ base: '.bashrc', extension: '' });
    expect(splitName('name.')).toEqual({ base: 'name.', extension: '' });
    expect(splitName('noextension')).toEqual({ base: 'noextension', extension: '' });
  });
});

describe('dedupeCandidates', () => {
  it('produces numbered variants that keep the extension', () => {
    expect(dedupeCandidates('movie.mp4', 3)).toEqual(['movie (1).mp4', 'movie (2).mp4', 'movie (3).mp4']);
  });

  it('handles names without an extension', () => {
    expect(dedupeCandidates('README', 2)).toEqual(['README (1)', 'README (2)']);
  });

  it('defaults to fifty candidates', () => {
    expect(dedupeCandidates('a.txt')).toHaveLength(50);
  });
});

describe('nextAvailableName', () => {
  it('returns the original name when nothing collides', async () => {
    const result = await nextAvailableName('movie.mp4', async () => false);
    expect(result).toBe('movie.mp4');
  });

  it('walks to the first free candidate', async () => {
    const taken = new Set(['movie.mp4', 'movie (1).mp4', 'movie (2).mp4']);
    const result = await nextAvailableName('movie.mp4', async (name) => taken.has(name));
    expect(result).toBe('movie (3).mp4');
  });

  it('asks about the original name before any candidate', async () => {
    const asked: string[] = [];
    await nextAvailableName('a.txt', async (name) => {
      asked.push(name);
      return asked.length < 3;
    });
    expect(asked).toEqual(['a.txt', 'a (1).txt', 'a (2).txt']);
  });

  it('falls back to a timestamp when every candidate is taken', async () => {
    const result = await nextAvailableName('movie.mp4', async () => true, 5);
    expect(result).toMatch(/^movie \(\d{10,}\)\.mp4$/);
  });
});
