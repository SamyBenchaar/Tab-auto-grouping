// Extraction of the search query from search-engine / site-search URLs (strong context signal).
import { LIMITS } from '../core/constants.js';
import { cleanText } from '../core/text.js';
import { parseHttpUrl } from '../core/url.js';

const ENGINES = [
  // Google Maps: /maps/search/<query>/@lat,lng
  { host: /(^|\.)google\.[a-z.]+$/, pathQuery: /^\/maps\/search\/([^/@]+)/ },
  { host: /(^|\.)google\.[a-z.]+$/, params: ['q'] },
  { host: /(^|\.)bing\.com$/, params: ['q'] },
  { host: /(^|\.)duckduckgo\.com$/, params: ['q'] },
  { host: /(^|\.)search\.yahoo\.com$/, params: ['p', 'q'] },
  { host: /(^|\.)ecosia\.org$/, params: ['q'] },
  { host: /(^|\.)qwant\.com$/, params: ['q'] },
  { host: /(^|\.)search\.brave\.com$/, params: ['q'] },
  { host: /(^|\.)startpage\.com$/, params: ['query', 'q'] },
  { host: /(^|\.)yandex\.[a-z.]+$/, params: ['text'] },
  { host: /(^|\.)baidu\.com$/, params: ['wd', 'word'] },
  { host: /(^|\.)perplexity\.ai$/, params: ['q'] },
  { host: /(^|\.)youtube\.com$/, params: ['search_query'] },
  { host: /(^|\.)amazon\.[a-z.]+$/, params: ['k', 'field-keywords'] },
  { host: /(^|\.)ebay\.[a-z.]+$/, params: ['_nkw'] },
  { host: /(^|\.)wikipedia\.org$/, params: ['search'] },
];

// Site-internal searches (thefork.fr/search?q=…, lacentrale.fr/listing?query=…).
const GENERIC_PARAMS = ['q', 'query', 'search', 'search_query', 'searchTerm', 'keywords', 'keyword', 'term'];

function clean(value) {
  const text = cleanText(value, LIMITS.queryLength);
  // Ignore redirect targets such as google.com/url?q=https://…
  return text && !/^https?:\/\//i.test(text) ? text : null;
}

function decodePathQuery(segment) {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' '));
  } catch {
    return segment.replace(/\+/g, ' ');
  }
}

/** @returns {string|null} */
export function extractSearchQuery(rawUrl) {
  const url = parseHttpUrl(rawUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  for (const engine of ENGINES) {
    if (!engine.host.test(host)) continue;
    if (engine.pathQuery) {
      const match = url.pathname.match(engine.pathQuery);
      if (match) return clean(decodePathQuery(match[1]));
      continue;
    }
    for (const param of engine.params) {
      const value = clean(url.searchParams.get(param) ?? '');
      if (value) return value;
    }
  }
  for (const param of GENERIC_PARAMS) {
    const value = clean(url.searchParams.get(param) ?? '');
    if (value) return value;
  }
  return null;
}
