// tests/providers/henkel.test.mjs — CoreMedia queryresults JSON collection.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — henkel (CoreMedia queryresults collection)');
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/henkel.mjs')).href);
  const henkel = mod.default;
  const { parseCollectionId, parseQueryResults, normalizeRow, resolveMaxPages, isHenkelEntry } = mod;

  // --- id ---
  if (henkel.id === 'henkel') pass('henkel.id is "henkel"');
  else fail(`henkel.id is ${JSON.stringify(henkel.id)}`);

  // --- detect() ---
  const ok = henkel.detect({ careers_url: 'https://www.henkel.com/careers/find-your-job-apply' });
  if (ok && ok.url === 'https://www.henkel.com/careers/find-your-job-apply') pass('henkel.detect() claims the www careers URL');
  else fail(`henkel.detect() should claim the www careers URL: ${JSON.stringify(ok)}`);
  if (henkel.detect({ careers_url: 'https://henkel.com/jobs' })) pass('henkel.detect() claims the apex host too');
  else fail('henkel.detect() should claim the apex host');
  if (
    henkel.detect({ careers_url: 'https://henkel.com.evil.example/x' }) === null &&
    henkel.detect({ careers_url: 'https://evil.example/www.henkel.com' }) === null &&
    henkel.detect({ careers_url: 'https://nothenkel.com/careers' }) === null
  ) pass('henkel.detect() rejects spoofed hosts');
  else fail('henkel.detect() should reject spoofed hosts');
  if (
    henkel.detect({ careers_url: 'ftp://www.henkel.com/careers' }) === null &&
    henkel.detect({ careers_url: 'not a url' }) === null &&
    henkel.detect({ careers_url: null }) === null &&
    henkel.detect({ careers_url: 42 }) === null &&
    henkel.detect({}) === null
  ) pass('henkel.detect() returns null for non-https / malformed / missing careers_url');
  else fail('henkel.detect() should return null for non-https / malformed / missing careers_url');

  // --- page ceiling ---
  if (resolveMaxPages({}) === 60) pass('henkel DEFAULT_MAX_PAGES is 60 when the entry sets none');
  else fail(`henkel default max pages wrong: ${resolveMaxPages({})}`);
  if (resolveMaxPages({ max_pages: 5000 }) === 300) pass('henkel caps a user max_pages override at MAX_PAGES_CAP');
  else fail(`henkel should cap max_pages at 300: ${resolveMaxPages({ max_pages: 5000 })}`);

  // --- parseCollectionId ---
  const widget = '<div data-ajax-url="/ajax/collection/en/2083458-2083458/queryresults/asJson" class="bab-filters"></div>';
  if (parseCollectionId(widget) === '2083458-2083458') pass('henkel.parseCollectionId() reads the widget collection id');
  else fail(`henkel.parseCollectionId() wrong: ${parseCollectionId(widget)}`);
  let threw = false;
  try { parseCollectionId('<html>no widget</html>'); } catch { threw = true; }
  if (threw) pass('henkel.parseCollectionId() throws when the markup carries no collection id');
  else fail('henkel.parseCollectionId() should throw on changed markup');

  // --- normalizeRow ---
  const row = {
    id: '2281554',
    title: 'Internship International Marketing &amp; Fibre Clinix',
    location: 'Germany, Hamburg,  Henkel Consumer Brands',
    link: '/careers/find-your-job-apply/2281554-2281554',
  };
  const job = normalizeRow(row, 'ExampleCo');
  if (job?.title === 'Internship International Marketing & Fibre Clinix') pass('henkel.normalizeRow() decodes entities in the title before any keyword match');
  else fail(`henkel.normalizeRow() title wrong: ${JSON.stringify(job?.title)}`);
  if (job?.url === 'https://www.henkel.com/careers/find-your-job-apply/2281554-2281554') pass('henkel.normalizeRow() builds an absolute URL on the careers host');
  else fail(`henkel.normalizeRow() url wrong: ${JSON.stringify(job?.url)}`);
  if (job?.location === 'Germany, Hamburg, Henkel Consumer Brands') pass('henkel.normalizeRow() keeps the full location string, whitespace collapsed');
  else fail(`henkel.normalizeRow() location wrong: ${JSON.stringify(job?.location)}`);
  if (job && !('requisitionId' in job)) pass('henkel.normalizeRow() sets no requisitionId (the payload carries a posting id only)');
  else fail('henkel.normalizeRow() should not set requisitionId from a posting id');
  if (
    normalizeRow({ title: 'No link' }, 'ExampleCo') === null &&
    normalizeRow({ link: '/x' }, 'ExampleCo') === null &&
    normalizeRow(null, 'ExampleCo') === null
  ) pass('henkel.normalizeRow() drops rows missing title or link');
  else fail('henkel.normalizeRow() should drop rows missing a required field');
  if (
    normalizeRow({ title: 'T', link: '//evil.example/x' }, 'ExampleCo') === null &&
    normalizeRow({ title: 'T', link: 'https://evil.example/x' }, 'ExampleCo') === null
  ) pass('henkel.normalizeRow() drops a protocol-relative or off-host link');
  else fail('henkel.normalizeRow() should drop an off-host link');

  // --- empty vs broken ---
  const empty = parseQueryResults({ resultsTotal: 0, resultsRemaining: 0, results: [] }, 'ExampleCo');
  if (empty.jobs.length === 0 && empty.rawCount === 0) pass('henkel.parseQueryResults() returns [] for a present-and-empty results[]');
  else fail('henkel.parseQueryResults() should return [] for an empty board');
  for (const [label, body] of [['{}', {}], ['{results:null}', { results: null }], ['{results:{}}', { results: {} }], ['a string', ''], ['a number', 7]]) {
    let t = false;
    try { parseQueryResults(body, 'ExampleCo'); } catch { t = true; }
    if (!t) { fail(`henkel.parseQueryResults() should throw for ${label}`); throw new Error('envelope guard'); }
  }
  pass('henkel.parseQueryResults() throws a descriptive error when the results[] envelope is absent or wrong-typed');
  const mixed = parseQueryResults({ resultsTotal: 2, results: [row, { title: 'bad' }] }, 'ExampleCo');
  if (mixed.jobs.length === 1 && mixed.rawCount === 2) pass('henkel.parseQueryResults() reports the source rawCount, not the post-filter count');
  else fail(`henkel.parseQueryResults() rawCount wrong: ${JSON.stringify(mixed)}`);

  // --- fetch(): pagination, redirect:'error', probe cooperation ---
  const PAGE = 20;
  const mkRow = (n) => ({ id: String(n), title: `Role ${n}`, location: 'Netherlands, Nieuwegein, Adhesive Technologies', link: `/careers/find-your-job-apply/${n}-${n}` });
  const mkCtx = (pageCount, opts = {}) => {
    const calls = [];
    return {
      calls,
      maxPages: opts.maxPages,
      sleep: () => Promise.resolve(),
      fetchText: async (url, o) => { calls.push({ url, redirect: o?.redirect, kind: 'text' }); return widget; },
      fetchJson: async (url, o) => {
        calls.push({ url, redirect: o?.redirect, kind: 'json' });
        const idx = Number(new URL(url).searchParams.get('startIndex'));
        const n = idx / PAGE < pageCount ? PAGE : 0;
        return { resultsTotal: pageCount * PAGE, resultsRemaining: 999, results: Array.from({ length: n }, (_, i) => mkRow(idx + i)) };
      },
    };
  };
  const entry = { name: 'ExampleCo', careers_url: 'https://www.henkel.com/careers/find-your-job-apply' };

  const ctx1 = mkCtx(2);
  const jobs1 = await henkel.fetch(entry, ctx1);
  if (jobs1.length === 40) pass('henkel.fetch() walks pages until the source returns a short page');
  else fail(`henkel.fetch() returned ${jobs1.length}, expected 40`);
  if (ctx1.calls.every((c) => c.redirect === 'error')) pass("henkel.fetch() passes redirect:'error' on every request (careers page and each results page)");
  else fail(`henkel.fetch() must pass redirect:'error' everywhere: ${JSON.stringify(ctx1.calls)}`);
  if (jobs1.truncated === undefined) pass('henkel.fetch() does not mark a naturally-ended walk as truncated');
  else fail(`henkel.fetch() should not mark a complete walk truncated: ${JSON.stringify(jobs1.truncated)}`);

  const ctx2 = mkCtx(99);
  const jobs2 = await henkel.fetch({ ...entry, max_pages: 3 }, ctx2);
  if (jobs2.length === 60 && ctx2.calls.filter((c) => c.kind === 'json').length === 3) pass("henkel.fetch() stops at the entry's own max_pages even when the source reports more");
  else fail(`henkel.fetch() max_pages stop wrong: ${jobs2.length} jobs, ${ctx2.calls.filter((c) => c.kind === 'json').length} page calls`);
  if (jobs2.truncated?.reason === 'page-cap' && jobs2.truncated.total === 1980) pass('henkel.fetch() marks a page-cap stop with reason and counts');
  else fail(`henkel.fetch() truncation marker wrong: ${JSON.stringify(jobs2.truncated)}`);

  const ctx3 = mkCtx(99, { maxPages: 1 });
  const jobs3 = await henkel.fetch(entry, ctx3);
  if (ctx3.calls.filter((c) => c.kind === 'json').length === 1) pass('henkel.fetch() issues exactly one list request under ctx.maxPages: 1 (health probe)');
  else fail(`henkel.fetch() probe made ${ctx3.calls.filter((c) => c.kind === 'json').length} list requests, expected 1`);
  if (jobs3.truncated === undefined) pass('henkel.fetch() does not raise the "raise max_pages" truncation on a probe cap');
  else fail('henkel.fetch() should not mark truncation on a probe cap');

  // A ctx.fetch* rejection while probing propagates unwrapped, so
  // verify-portals can recognize ProbePageBudgetReached.
  class Sentinel extends Error {}
  const ctx4 = {
    maxPages: 1,
    sleep: () => Promise.resolve(),
    fetchText: async () => { throw new Sentinel('probe budget'); },
    fetchJson: async () => { throw new Sentinel('probe budget'); },
  };
  let propagated = false;
  try { await henkel.fetch(entry, ctx4); } catch (err) { propagated = err instanceof Sentinel; }
  if (propagated) pass('henkel.fetch() propagates a ctx.fetch* rejection unwrapped while probing');
  else fail('henkel.fetch() must not wrap or swallow a ctx.fetch* rejection while probing');

  // Outside a probe, an unreadable careers page falls back to the seed
  // collection id rather than losing the whole board.
  const ctx5 = {
    sleep: () => Promise.resolve(),
    fetchText: async () => { throw new Error('careers page 503'); },
    fetchJson: async (url, o) => {
      if (!url.includes('/ajax/collection/en/')) throw new Error(`unexpected url ${url}`);
      if (o?.redirect !== 'error') throw new Error("redirect must be 'error'");
      return { resultsTotal: 1, results: [mkRow(1)] };
    },
  };
  const jobs5 = await henkel.fetch(entry, ctx5);
  if (jobs5.length === 1) pass('henkel.fetch() falls back to the seed collection id when the careers page is unreadable (non-probe)');
  else fail(`henkel.fetch() seed fallback wrong: ${jobs5.length}`);

  // An entry-level override skips the careers-page lookup entirely.
  const ctx6 = mkCtx(1);
  await henkel.fetch({ ...entry, henkel: { collection: '1234-5678' } }, ctx6);
  if (!ctx6.calls.some((c) => c.kind === 'text') && ctx6.calls[0].url.includes('/en/1234-5678/')) pass('henkel.fetch() honours an entry collection override and skips the careers-page lookup');
  else fail(`henkel.fetch() override wrong: ${JSON.stringify(ctx6.calls)}`);

  // A non-henkel.com entry is refused before any network call.
  const ctx7 = { sleep: () => Promise.resolve(), fetchText: async () => { throw new Error('must not fetch'); }, fetchJson: async () => { throw new Error('must not fetch'); } };
  let guarded = false;
  try { await henkel.fetch({ name: 'ExampleCo', careers_url: 'https://evil.example/jobs' }, ctx7); } catch (err) { guarded = /not a henkel\.com URL/.test(err.message); }
  if (guarded) pass('henkel.fetch() rejects a non-henkel.com careers_url before any fetch');
  else fail('henkel.fetch() should reject a non-henkel.com careers_url before fetching');

  if (isHenkelEntry({ api: 'https://www.henkel.com/x' })) pass('henkel.isHenkelEntry() reads entry.api as well as careers_url');
  else fail('henkel.isHenkelEntry() should read entry.api');
} catch (err) {
  fail(`henkel provider test threw: ${err.message}`);
}
