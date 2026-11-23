#!/usr/bin/env node
// Browser-free smoke test for a built static site. Zero deps, Node >= 18.
//
//   node smoke.mjs [--dist dist] [--base /] [--umami true|false] [--ignore 're1,re2']
//
// 1. Serves dist/ on 127.0.0.1 with a tiny static server.
// 2. For every sitemap URL (or every **/index.html when there is no sitemap):
//    HTTP 200, non-empty <title>, Umami snippet present (unless --umami false).
// 3. Offline internal link check over every dist/**/*.html: href, src, srcset,
//    poster must resolve to a file in dist/ (or a netlify/_redirects source).
//    External links are skipped, so are paths matching --ignore (regexes, comma
//    or newline separated, e.g. other GitHub Pages projects on the same domain).
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1] ?? 'true']);
    return acc;
  }, []),
);
const DIST = path.resolve(args.dist ?? 'dist');
const BASE = ('/' + (args.base ?? '/').replace(/^\/+|\/+$/g, '') + '/').replace('//', '/');
const UMAMI = (args.umami ?? 'true') !== 'false';
const UMAMI_SNIPPET = 'edge.arnaud.codes/app.js';
const IGNORE = (args.ignore ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s));

if (!existsSync(DIST)) fail([`dist not found: ${DIST}`]);

// ---------- file resolution (shared by server + link checker) ----------
function resolveFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split(/[?#]/)[0]); } catch { p = urlPath.split(/[?#]/)[0]; }
  if (BASE !== '/' && p.startsWith(BASE)) p = '/' + p.slice(BASE.length);
  else if (BASE !== '/' && (p + '/') === BASE) p = '/';
  const abs = path.join(DIST, path.normalize(p));
  if (!abs.startsWith(DIST)) return null;
  const candidates = p.endsWith('/') ? [path.join(abs, 'index.html')] : [abs, abs + '.html', path.join(abs, 'index.html')];
  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  return null;
}
const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };

const TYPES = { '.html': 'text/html; charset=utf-8', '.xml': 'application/xml', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

// ---------- redirects (netlify.toml + _redirects): sources count as valid targets ----------
function loadRedirectSources() {
  const out = [];
  const toml = path.resolve(DIST, '..', 'netlify.toml');
  if (existsSync(toml)) for (const m of readFileSync(toml, 'utf8').matchAll(/^\s*from\s*=\s*["']([^"']+)["']/gm)) out.push(m[1]);
  const red = path.join(DIST, '_redirects');
  if (existsSync(red)) for (const line of readFileSync(red, 'utf8').split('\n')) {
    const src = line.trim().split(/\s+/)[0];
    if (src && !src.startsWith('#')) out.push(src);
  }
  return out
    .filter((s) => s.startsWith('/'))
    .map((s) => new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*$|\*$/, '.*').replace(/:[a-zA-Z]+/g, '[^/]+') + '/?$'));
}
const REDIRECTS = loadRedirectSources();
const isRedirected = (p) => REDIRECTS.some((re) => re.test(p));

// ---------- helpers ----------
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(f)));
    else out.push(f);
  }
  return out;
}
function fail(lines) {
  console.error('\n✗ smoke test failed:\n' + lines.map((l) => '  - ' + l).join('\n') + '\n');
  process.exit(1);
}
const toUrlPath = (file) => '/' + path.relative(DIST, file).split(path.sep).join('/').replace(/(^|\/)index\.html$/, '$1');

// ---------- server ----------
const server = createServer(async (req, res) => {
  const f = resolveFile(new URL(req.url, 'http://x').pathname);
  if (!f) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  res.end(await readFile(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const errors = [];
const allFiles = await walk(DIST);
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));

// ---------- 1. page list ----------
let siteOrigin = null;
async function sitemapLocs(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const xml = await readFile(file, 'utf8');
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const pages = [];
  for (const loc of locs) {
    const u = new URL(loc);
    siteOrigin ??= u.origin;
    if (/\.xml$/.test(u.pathname) && /<sitemapindex/.test(xml)) {
      const sub = resolveFile(u.pathname);
      if (sub) pages.push(...(await sitemapLocs(sub, seen)));
      else errors.push(`sitemap index points to missing ${u.pathname}`);
    } else pages.push(u.pathname + u.search);
  }
  return pages;
}
const sitemapFile = ['sitemap-index.xml', 'sitemap.xml'].map((f) => path.join(DIST, f)).find(existsSync);
let pages = sitemapFile ? await sitemapLocs(sitemapFile) : [];
const source = pages.length ? path.basename(sitemapFile) : 'dist/**/index.html';
if (!pages.length) pages = htmlFiles.filter((f) => path.basename(f) === 'index.html').map(toUrlPath);
if (!pages.length) errors.push('no pages found (no sitemap URLs, no index.html)');

// ---------- 2. page checks ----------
const results = await Promise.all(pages.map(async (p) => {
  const r = await fetch(ORIGIN + p).catch((e) => ({ status: 0, text: async () => String(e) }));
  const body = await r.text();
  const probs = [];
  if (r.status !== 200) probs.push(`HTTP ${r.status}`);
  else {
    const t = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!t || !t[1].trim()) probs.push('empty or missing <title>');
    if (UMAMI && !body.includes(UMAMI_SNIPPET)) probs.push(`missing Umami snippet (${UMAMI_SNIPPET})`);
  }
  return probs.map((x) => `${p}: ${x}`);
}));
errors.push(...results.flat());

// ---------- 3. internal link check ----------
const broken = new Map(); // target -> first page
const SKIP = /^(mailto:|tel:|sms:|javascript:|data:|blob:|#|\{|\$)/i;
const ATTR = /\s(href|src|srcset|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
let linkCount = 0;
for (const file of htmlFiles) {
  const pagePath = toUrlPath(file);
  const html = (await readFile(file, 'utf8'))
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
    if (/^<base\b/i.test(tag)) continue;
    // the 404 page's canonical points at /404/, which no host serves as such
    if (/^\/404(\.html)?$/.test(pagePath) && /^<link\b/i.test(tag) && /rel=["']?canonical/i.test(tag)) continue;
    for (const m of tag.matchAll(ATTR)) {
      const raw = (m[3] ?? m[4] ?? '').replace(/&amp;/g, '&').trim();
      const values = m[1].toLowerCase() === 'srcset' ? raw.split(',').map((s) => s.trim().split(/\s+/)[0]) : [raw];
      for (const v of values) {
        if (!v || SKIP.test(v)) continue;
        let u;
        try { u = new URL(v, (siteOrigin ?? 'http://site.invalid') + pagePath); } catch { continue; }
        if (u.origin !== (siteOrigin ?? 'http://site.invalid')) continue; // external
        linkCount++;
        let p = u.pathname;
        try { p = decodeURI(p); } catch {}
        if (resolveFile(u.pathname) || isRedirected(p) || IGNORE.some((re) => re.test(p)) || p.startsWith('/.netlify/') || p.startsWith('/cdn-cgi/')) continue;
        if (!broken.has(p)) broken.set(p, pagePath);
      }
    }
  }
}
for (const [target, from] of broken) errors.push(`broken internal link ${target} (first seen on ${from})`);

server.close();
if (errors.length) fail(errors);
console.log(`✓ ${pages.length} pages OK (from ${source}; title${UMAMI ? ' + Umami' : ''}), ${linkCount} internal links across ${htmlFiles.length} HTML files OK`);
