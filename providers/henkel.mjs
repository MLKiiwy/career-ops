// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';
import { cachedLookup } from './_cached-lookup.mjs';
import { markTruncated } from '../lib/board-truncation.mjs';

// Henkel provider — single-company (pattern: ibm/dassault/rheinmetall/hecklerkoch).
// Target list: `tracked_companies:`.
//
// Henkel publishes no vendor ATS board. `jobs.henkel.com` resolves but serves
// a 16-byte placeholder ("sftp.babiel.com"), and `www.henkel.com/jobs` 200s
// straight back to the careers page. The real inventory lives behind the
// CoreMedia filter widget on /careers/find-your-job-apply, which reads a
// public, no-auth JSON collection endpoint:
//
//   GET /ajax/collection/en/{collection}/queryresults/asJson
//       ?startIndex=0&loadCount=20
//   -> { resultsTotal: 995, resultsRemaining: 975, results: [
//          { id: "2281556",
//            title: "Global Process Expert",
//            location: "Philippines, Makati, Global Business Solutions+",
//            link: "/careers/find-your-job-apply/2281556-2281556" }, ... ] }
//
// The sitemap route is closed: www.henkel.com/robots.txt advertises only
// service-sitemap-com-sitemap_index.xml, whose seven children are all `.gz`,
// which providers/sitemap.mjs refuses by design. Hence this adapter.
//
// `startIndex` / `loadCount` are the widget's own paging params (read off the
// careers bundle's sendRequest(): `[{name:"startIndex",...},{name:"loadCount",
// ...}]`). The backend clamps `loadCount` to 20 however much more is asked
// for, so PAGE_SIZE is 20 and a full walk of the global board (995 postings
// observed 2026-11-26) is ~50 pages.
//
// The `location` string is "{Country}, {City}, {Business unit}" and is passed
// through verbatim — portals.yml `location_filter` matches on substrings, so
// both the country and the city are available to it. The trailing business
// unit is kept rather than stripped because the field is not always three
// parts, and dropping a part we cannot reliably identify loses real signal.
//
// `id` is the posting id (it changes when a req is re-released), not the
// employer's requisition id, so `requisitionId` is deliberately left unset
// per the provider contract. The payload carries no date and no description.

const HOST = 'www.henkel.com';

// Observed live 2026-11-26 on /careers/find-your-job-apply. Only a seed: the
// id is re-read from the careers page (and cached between scans) on every
// fetch, so a changed id is picked up without a release. A stale id fails
// loudly rather than silently — the endpoint answers 400, not an empty list.
const DEFAULT_COLLECTION = '2083458-2083458';

const PAGE_SIZE = 20; // backend clamp; asking for more returns 20
const DEFAULT_MAX_PAGES = 60; // ~1,200 postings — above the 995 observed
const MAX_PAGES_CAP = 300; // hard ceiling even when the entry raises max_pages
const INTER_PAGE_DELAY_MS = 250;

const COLLECTION_RE = /^[0-9]+-[0-9]+$/;

/** @param {unknown} v */
function isValidCollection(v) {
  return typeof v === 'string' && COLLECTION_RE.test(v);
}

/** @param {any} entry */
export function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * Accept only a henkel.com careers URL, and keep nothing from it but the
 * host decision — the request URL is rebuilt from the literal HOST below.
 * @param {any} entry
 */
export function isHenkelEntry(entry) {
  const raw = entry?.api || entry?.careers_url || '';
  if (typeof raw !== 'string' || !raw) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'henkel.com' || host === 'www.henkel.com';
}

/**
 * Read the collection id out of the careers page's widget markup:
 *   data-ajax-url="/ajax/collection/en/2083458-2083458/queryresults/asJson"
 * Throws when the page does not carry it, so cachedLookup keeps the last
 * known value instead of caching a bad one.
 * @param {string} html
 */
export function parseCollectionId(html) {
  if (typeof html !== 'string') {
    throw new Error('henkel: careers page unreadable — cannot resolve collection id');
  }
  const m = html.match(/\/ajax\/collection\/[a-z-]+\/([0-9]+-[0-9]+)\/queryresults\/asJson/i);
  if (!m) {
    throw new Error('henkel: careers page carries no queryresults collection id (markup changed?)');
  }
  return m[1];
}

/**
 * Normalize one `results[]` row. Returns null for a row that cannot become a
 * Job, so one bad row never costs the board.
 * @param {any} row
 * @param {string} company
 */
export function normalizeRow(row, company) {
  if (!row || typeof row !== 'object') return null;
  const title = typeof row.title === 'string' ? decodeEntities(row.title).replace(/\s+/g, ' ').trim() : '';
  const link = typeof row.link === 'string' ? row.link.trim() : '';
  if (!title || !link) return null;
  // Same-host relative path only. A protocol-relative "//evil.example" or an
  // absolute URL off the careers host is dropped rather than followed.
  if (!link.startsWith('/') || link.startsWith('//')) return null;
  const location = typeof row.location === 'string'
    ? decodeEntities(row.location).replace(/\s+/g, ' ').trim()
    : '';
  return { title, url: `https://${HOST}${link}`, company, location };
}

/**
 * @param {any} json
 * @param {string} company
 */
export function parseQueryResults(json, company) {
  const rows = json && Array.isArray(json.results) ? json.results : null;
  if (!rows) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`henkel: unexpected response — expected results[], got: [${got}]`);
  }
  const jobs = [];
  for (const row of rows) {
    const job = normalizeRow(row, company);
    if (job) jobs.push(job);
  }
  // rawCount is the source's own page size — the short-page stop reads this,
  // never the post-filter length (a single bad row would end the walk early).
  return { jobs, rawCount: rows.length, total: Number(json.resultsTotal) };
}

/** @type {Provider} */
export default {
  id: 'henkel',

  detect(entry) {
    const url = entry?.api || entry?.careers_url || '';
    if (typeof url !== 'string') return null;
    return isHenkelEntry(entry) ? { url } : null;
  },

  async fetch(entry, ctx) {
    if (!isHenkelEntry(entry)) {
      throw new Error(`henkel: ${entry?.name} careers_url is not a henkel.com URL`);
    }

    const probing = Number(ctx?.maxPages) > 0;
    const override = entry?.henkel?.collection;

    let collection;
    if (isValidCollection(override)) {
      collection = override;
    } else {
      collection = await cachedLookup(
        ctx?.idCache,
        `collection:${HOST}`,
        async () => {
          const html = await ctx.fetchText(`https://${HOST}/careers/find-your-job-apply`, {
            headers: { accept: 'text/html' },
            redirect: 'error',
          });
          return parseCollectionId(html);
        },
        { isValid: isValidCollection },
      ).catch((err) => {
        // A probe must see a ctx.fetch* rejection unwrapped, so verify-portals
        // can tell ProbePageBudgetReached from a broken board.
        if (probing) throw err;
        // Otherwise fall back to the seed id rather than lose a ~995-posting
        // board to a cosmetic markup change. A genuinely dead id answers 400
        // on the first page below, which still surfaces as an error.
        return DEFAULT_COLLECTION;
      });
    }

    const base = `https://${HOST}/ajax/collection/en/${encodeURIComponent(collection)}/queryresults/asJson`;
    const ctxCap = probing ? Number(ctx.maxPages) : Infinity;
    const entryCap = resolveMaxPages(entry);
    const pagesToFetch = Math.min(entryCap, ctxCap);

    const jobs = [];
    const seen = new Set();
    let total;
    let page = 0;
    let hitCap = false;

    for (; page < pagesToFetch; page += 1) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = `${base}?startIndex=${page * PAGE_SIZE}&loadCount=${PAGE_SIZE}`;
      const json = await ctx.fetchJson(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
      const { jobs: pageJobs, rawCount, total: pageTotal } = parseQueryResults(json, entry.name);
      if (Number.isFinite(pageTotal)) total = pageTotal;
      for (const job of pageJobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      // The walk's own natural end — a short or empty page — is the only
      // proof it is complete; resultsTotal is never trusted as that proof.
      if (rawCount < PAGE_SIZE) return jobs;
      if (page + 1 >= pagesToFetch) hitCap = true;
    }

    if (hitCap && !probing && entryCap <= pagesToFetch) {
      console.warn(
        `⚠️  henkel: stopped at ${pagesToFetch} pages (${jobs.length} postings` +
          `${Number.isFinite(total) ? ` of ${total}` : ''}) — raise max_pages on this entry for the rest`,
      );
      return markTruncated(jobs, 'page-cap', { fetched: jobs.length, total });
    }
    return jobs;
  },
};
