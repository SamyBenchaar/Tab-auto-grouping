// URL helpers: domain extraction and data-minimised URL for the model.
import { LIMITS } from './constants.js';
import { truncate } from './text.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse an http(s) URL; anything else (chrome://, about:, file:, invalid) returns null. */
export function parseHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  return url.hostname.toLowerCase().replace(/^www\d?\./, '');
}

/** "https://www.lacentrale.fr/listing?x=1" -> "lacentrale.fr" ('' for non-http URLs). */
export function getDomain(raw) {
  const url = parseHttpUrl(raw);
  return url ? hostOf(url) : '';
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'gouv', 'ac', 'edu']);

/** Human-friendly site label: "fr.khanacademy.org" -> "khanacademy", "bbc.co.uk" -> "bbc". */
export function siteLabel(domain) {
  const labels = String(domain ?? '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 1) return labels[0] ?? '';
  let index = labels.length - 2;
  if (labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[index])) {
    index -= 1;
  }
  return labels[index];
}

/**
 * A path segment is considered sensitive when it looks like an identifier or a secret:
 * e-mail, UUID, long random token (reset links, capability URLs such as Google Docs ids),
 * or a long number (order ids, phone numbers).
 */
export function isSensitiveSegment(segment) {
  if (segment.includes('@') || UUID.test(segment)) return true;
  return segment
    .split(/[-_.~+,;=]+/)
    .some(
      (chunk) =>
        chunk.length >= 20 ||
        (chunk.length >= 12 && /\d/.test(chunk) && /[a-z]/i.test(chunk)) ||
        /^\d{9,}$/.test(chunk),
    );
}

/**
 * Data-minimised URL sent to the model: host + path only. The query string and the fragment
 * are always dropped (tokens, session ids, auth codes…) and sensitive path segments are masked.
 * "https://docs.google.com/document/d/1AbC…xyz/edit?usp=sharing" -> "docs.google.com/document/d/…/edit"
 */
export function toModelUrl(raw) {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep the raw segment
      }
      return isSensitiveSegment(decoded) ? '…' : decoded;
    });
  const path = segments.length ? `/${segments.join('/')}` : '';
  return truncate(`${hostOf(url)}${path}`, LIMITS.urlLength);
}
