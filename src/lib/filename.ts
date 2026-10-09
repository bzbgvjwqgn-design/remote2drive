const MAX_NAME_LENGTH = 200;
const FALLBACK_NAME = 'download';

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/octet-stream': '',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-tar': '.tar',
  'application/x-7z-compressed': '.7z',
  'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar',
  'application/x-bzip2': '.bz2',
  'application/x-xz': '.xz',
  'application/x-iso9660-image': '.iso',
  'application/vnd.android.package-archive': '.apk',
  'application/epub+zip': '.epub',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/wasm': '.wasm',
  'application/javascript': '.js',
  'application/x-javascript': '.js',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/css': '.css',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/xml': '.xml',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'audio/webm': '.weba',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
};

/**
 * Extracts a filename from Content-Disposition, honouring RFC 6266: the
 * extended `filename*` parameter wins over the plain `filename` one because it
 * carries a charset and can therefore represent non-ASCII names correctly.
 */
export function parseContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;

  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    const charset = (extended[1] ?? '').toLowerCase();
    const raw = (extended[2] ?? '').trim().replace(/^"|"$/g, '');
    if (charset === '' || charset === 'utf-8' || charset === "utf8") {
      try {
        return decodeURIComponent(raw);
      } catch {
        // Fall through to the plain parameter below.
      }
    }
  }

  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return (quoted[1] ?? '').replace(/\\(.)/g, '$1');

  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare) return (bare[1] ?? '').trim().replace(/^"|"$/g, '');

  return null;
}

export function sanitizeFileName(input: string): string {
  let name = input.normalize('NFC');

  // Drop any directory component from either separator style. This is the
  // traversal guard: the name ends up in a Drive API request, and a stray
  // "../" or absolute path must never get there.
  name = name.replace(/\\/g, '/');
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash !== -1) name = name.slice(lastSlash + 1);

  // Control characters and the set Windows/Drive reject outright.
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[<>:"/\\|?*]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (name === '' || name === '.' || name === '..') return FALLBACK_NAME;

  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    const base = name.slice(0, name.length - extension.length);
    name = `${base.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`;
  }
  return name;
}

export function extensionForMimeType(mimeType: string | null | undefined): string {
  if (!mimeType) return '';
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSION_BY_MIME[normalized] ?? '';
}

/** Last path segment of a URL, or null when it carries no usable name. */
export function nameFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  const sanitized = sanitizeFileName(decoded);
  return sanitized === FALLBACK_NAME ? null : sanitized;
}

export interface FileNameInputs {
  userSupplied?: string | null;
  contentDisposition?: string | null;
  contentType?: string | null;
  url: string;
}

/**
 * Precedence: explicit user choice, then the server's Content-Disposition,
 * then the URL path, then a generic name. An extension is appended when the
 * chosen name lacks one and the Content-Type implies one.
 */
export function pickFileName(inputs: FileNameInputs): string {
  const candidates = [
    inputs.userSupplied,
    parseContentDisposition(inputs.contentDisposition),
    nameFromUrl(inputs.url),
  ];

  let chosen: string | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const sanitized = sanitizeFileName(candidate);
    // A candidate that sanitizes down to nothing ("..", "   ") must not mask a
    // good name from a lower-priority source — but a file genuinely called
    // "download" is a real name and has to survive.
    const degraded =
      sanitized === FALLBACK_NAME && candidate.trim().toLowerCase() !== FALLBACK_NAME;
    if (degraded) continue;
    chosen = sanitized;
    break;
  }
  if (chosen === null) chosen = FALLBACK_NAME;

  const extension = extensionForMimeType(inputs.contentType);
  if (extension !== '' && !/\.[A-Za-z0-9]{1,11}$/.test(chosen)) {
    chosen = sanitizeFileName(`${chosen}${extension}`);
  }
  return chosen;
}

export function splitName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, extension: '' };
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/** Pure helper: "a.mp4" + taken{a.mp4} -> "a (1).mp4", "a (2).mp4", ... */
export function dedupeCandidates(name: string, max = 50): string[] {
  const { base, extension } = splitName(name);
  const out: string[] = [];
  for (let i = 1; i <= max; i += 1) {
    out.push(sanitizeFileName(`${base} (${i})${extension}`));
  }
  return out;
}

/**
 * Walks the candidate list until `exists` says no. Returns the original name
 * when nothing collides, and falls back to a timestamp suffix if every
 * candidate up to the limit is taken.
 */
export async function nextAvailableName(
  name: string,
  exists: (candidate: string) => Promise<boolean>,
  max = 50,
): Promise<string> {
  if (!(await exists(name))) return name;
  for (const candidate of dedupeCandidates(name, max)) {
    if (!(await exists(candidate))) return candidate;
  }
  const { base, extension } = splitName(name);
  return sanitizeFileName(`${base} (${Date.now()})${extension}`);
}
