# Upgrading a site from Astro 5 to Astro 7

Recipe from the pilot (a static blog: content collections, `astro:assets`, Tailwind 4 via `@tailwindcss/vite`, `@astrojs/rss`, `@astrojs/sitemap`, satori OG images, GitHub Pages). Took about an hour; most of it was the output diff.

Official guides: [v6](https://docs.astro.build/en/guides/upgrade-to/v6/), [v7](https://docs.astro.build/en/guides/upgrade-to/v7/). Go straight from 5 to 7; no need to stop at 6.

## 0. Prep

- Dependabot opens one PR per Astro version (e.g. `7.4.7`, then `7.4.13`). Don't build on them: start a fresh branch from the default branch, then close both Dependabot PRs pointing at yours. Major bumps aren't auto-merged by this CI, but a human-owned branch is clearer.
- Node: Astro 7.4 needs **Node ≥ 22.23** (`engines`). This CI defaults to 24 (or `.nvmrc` / `.node-version`). Check the deploy target too (GitHub Pages `withastro/action` with `node-version: 24`; on Netlify set `NODE_VERSION` ≥ 22.23 or 24). Simplest on Netlify: commit `.nvmrc` (`24.18.0`); both Netlify and this CI read it. A site with no pin runs Netlify's default image Node, so add one. Build locally on the same Node too (`fnm use 24`): some sites already need ≥ 22 for `fs.glob` in build hooks.

## 1. Baseline build (before touching anything)

```sh
rm -rf dist node_modules/.astro .astro
npm ci && npm run build
cp -R dist /tmp/dist-before
```

## 2. Bump

```sh
npm install astro@^7
npm outdated   # look for other @astrojs/* majors
```

- `@astrojs/rss` 4.x and `@astrojs/sitemap` 3.x work with 7; no new major needed.
- `@astrojs/mdx`, adapters (`@astrojs/netlify`, `@astrojs/node`, `@astrojs/vercel`, `@astrojs/cloudflare`) do have new majors since v6: bump them in the same PR.
- `@tailwindcss/vite` 4.x works with Vite 8 as is.
- `@astrojs/db` is removed in v7.
- `@astrojs/react` 4 → 7 directly: no code change (React 19, `client:idle` / `client:visible` islands hydrate fine). Bump it with astro in one PR; its Dependabot PR is separate.

## 3. Code changes

Grep first, so you know what applies:

```sh
grep -rnE "astro:content|\.url\(\)|\.email\(\)|errorMap|Astro\.glob|\.render\(|\.slug\b|getEntryBySlug|ViewTransitions|remarkPlugins|rehypePlugins|compressHTML|experimental|src/fetch\.ts" src astro.config.*
ls src/content/config.ts src/fetch.ts 2>/dev/null
```

Always needed:

1. **`compressHTML: true` in `astro.config.mjs`.** v7 defaults to `'jsx'`, which drops whitespace between tags: `<a>x</a> <a>y</a>` renders `xy`. On the pilot this changed all 31 pages. Setting it to `true` gives back the v5 output exactly.
2. **Zod 4 via `astro/zod`.**
   ```ts
   import { defineCollection } from 'astro:content';
   import { z } from 'astro/zod';          // was: z from 'astro:content' (deprecated)
   ```
   `z.string().url()` → `z.url()`, `z.string().email()` → `z.email()`, `{ message }` → `{ error }`, and `.default()` must match the output type (use `.prefault()` for the old behaviour).

Only if the site still uses them (v6 removed legacy collections):

- `src/content/config.ts` → `src/content.config.ts`, each collection gets `loader: glob({ pattern: '**/*.md', base: './src/content/<name>' })` from `astro/loaders`, remove `type: 'content'`.
- `entry.slug` → `entry.id`, `entry.render()` → `render(entry)` from `astro:content`, `getEntryBySlug` → `getEntry`. A `slug` field in a schema now errors.
- `Astro.glob(...)` → `Object.values(import.meta.glob(..., { eager: true }))`.
- `<ViewTransitions />` → `<ClientRouter />`.
- `Astro.site` inside `getStaticPaths` → `import.meta.env.SITE`; `params` values must be strings.
- remark/rehype plugins: v7 renders Markdown with Sätteri by default. To keep plugins, `npm i @astrojs/markdown-remark` and set `markdown: { processor: unified() }`.
- `import.meta.env` values are no longer coerced (`'true'` stays a string), and non-public vars are no longer read from `process.env`.
- `src/fetch.ts` is now a reserved file name (v7 advanced routing).
- Headings with trailing code/punctuation now keep a trailing hyphen in their `id` (`## <Picture />` → `#picture-`). Check deep links.
- The v7 Rust compiler is stricter: unclosed tags fail the build, invalid nesting (`<div>` in `<p>`) is no longer fixed up.
- Any `experimental` flags from v5/v6 are removed or stable now: delete them.

## 4. Checks

```sh
rm -rf dist node_modules/.astro .astro && npm run build
cp -R dist /tmp/dist-after
npm run dev   # open a few pages, RSS, an OG image
```

Compare before and after with the script below. Expect **no** difference in the first three; review the rest.

```sh
B=/tmp/dist-before A=/tmp/dist-after
# normalize asset hashes + scoped-CSS ids, one tag per line
norm() { sed -E 's/\.[A-Za-z0-9_-]{8}(_[A-Za-z0-9_-]+)?\.(webp|avif|css|js|png|jpe?g|svg|woff2?)/.H.\2/g; s/astro-[a-z0-9]{8}/astro-H/g; s/data-astro-cid-[a-z0-9]+/data-astro-cid-H/g' "$1" | sed -E 's/></>\n</g'; }

# 1. page list
diff <(tr '<' '\n' < $B/sitemap-0.xml | grep ^loc) <(tr '<' '\n' < $A/sitemap-0.xml | grep ^loc) && echo SITEMAP_OK
# 2. RSS / feeds
for f in $(cd $B && ls *.xml | grep -v sitemap); do cmp -s $B/$f $A/$f && echo "$f identical" || { xmllint --noout $A/$f && echo "$f differs but well-formed"; }; done
# 3. <title>, h1-h6 text and ids, per page
heads() { for f in $(cd $1 && find . -name '*.html' | sort); do echo "## $f"; perl -0ne 'while(/<(title|h[1-6])\b([^>]*)>(.*?)<\/\1>/gs){my($t,$a,$x)=($1,$2,$3);my($id)=$a=~/id="([^"]*)"/;$x=~s/<[^>]+>//g;$x=~s/\s+/ /g;print "$t#$id $x\n"}' $1/$f; done; }
diff <(heads $B) <(heads $A) && echo HEADINGS_OK
# 4. full normalized HTML diff, ignoring inline <script> (re-minified)
for f in $(cd $B && find . -name '*.html'); do diff <(norm $B/$f) <(norm $A/$f) | grep '^[<>]' | grep -v '<script'; done | sort | uniq -c | sort -rn | cut -c1-200 | less
```

Expected noise in step 4 (all safe on the pilot):

- Inline JS re-minified by Vite 8 / Rolldown (other variable names, backtick strings).
- CSS minified differently (property order, `@media (width>=40rem)` syntax, `calc()` no longer folded). Same rules. The bundle can be renamed (`_id_.css` → `<Component>.css`).
- Images: `style="--fit:…;--pos:…"` → `data-astro-image-fit` / `data-astro-image-pos` attributes; `fetchpriority="auto"` dropped on Markdown images (it's the default value).
- Raw HTML/SVG in Markdown re-serialized: `<path></path>` → `<path/>`, `&#x27;` → `'`, `&#34;` → `&quot;`.
- Unused original images (e.g. a cover only used through `<Image>`) are no longer copied to `dist/_astro`.
- `&` in attribute values is now escaped: `href="…?a=1&b=2"` → `&amp;b=2`, `content="… &#38; …"` → `&amp;`. Same decoded value.
- `fetchpriority="auto"` is also dropped on `<Image>` / `<Picture>` from `.astro` files, not only Markdown.

**`compressHTML: true` is not byte-identical to v5.** v7 keeps a single-space text node in places v5 removed (between a component's root tags, e.g. `<a class="block"> <img> </a>`, `<li> <a>`, `<button> <svg>`) and drops some next to `<script>` / `<style>`. Because step 4 only splits on `><`, this regroups lines and floods the diff. Harmless inside block, flex and grid containers (whitespace-only nodes there don't render); it matters only between inline / inline-block siblings. Use a token diff that keeps whitespace *presence* instead, then look at each whitespace change with its neighbours:

```sh
cat > /tmp/tok.pl <<'EOF'
local $/; my $h=<>;
$h=~s/<!--.*?-->//gs; $h=~s/<(script|style)\b[^>]*>.*?<\/\1>/<$1>/gs;
$h=~s/&amp;|&#38;/&/g; $h=~s/&#x27;|&#39;/'/g; $h=~s/&#34;|&quot;/"/g;
$h=~s/data-astro-cid-[a-z0-9]+//g; $h=~s/astro-[a-z0-9]{8}/astro-H/g;
$h=~s/\.[A-Za-z0-9_-]{8}(_[A-Za-z0-9_-]+)?\.(webp|avif|css|js|png|jpe?g|svg|woff2?)/.H.$2/g;
$h=~s/_astro\/[A-Za-z_-]+\.H\.css/_astro\/X.H.css/g; $h=~s/<meta name="generator"[^>]*>//;
$h=~s/\s+/ /g;
for my $t (split /(<[^>]+>)/, $h) { next if $t eq ''; if ($t=~/^</){ $t=~s/ +>/>/; $t=~s/\/>$/>/; print "$t\n" } else { print "T:$t\n" } }
EOF
# 5. tokens minus whitespace-only nodes: expect nothing (fetchpriority="auto" stripped from before)
for f in $(cd $B && find . -name '*.html'); do diff <(perl /tmp/tok.pl $B/$f | sed 's/ fetchpriority="auto"//' | grep -v '^T: $') <(perl /tmp/tok.pl $A/$f | grep -v '^T: $') | grep '^[<>]' | sed "s|^|$f |"; done | sort | uniq -c | sort -rn | cut -c1-200
# 6. whitespace-only node changes with context: check none sits between inline siblings
for f in $(cd $B && find . -name '*.html'); do diff -U3 <(perl /tmp/tok.pl $B/$f) <(perl /tmp/tok.pl $A/$f) | grep -B1 -A1 '^[-+]T: $'; done | less
```

What a real problem looks like: missing/extra page, changed title or heading, changed Markdown prose (Sätteri vs remark: watch for smart quotes, footnotes, tables, autolinks), whitespace vanishing between inline elements (you forgot `compressHTML: true`), missing `[data-astro-image…]` CSS if the site uses `image.responsiveStyles`.

## 5. PR

- Push, open the PR, close the Dependabot Astro PRs as superseded.
- This repo's CI (`astro check` when `@astrojs/check` is installed, build, smoke test of every sitemap page + internal links) must be green.
- In the PR body: the breaking changes that applied, the result of each check above, the pages a human should look at (pages with inline SVG, image grids, client scripts).
- Merging deploys: the site owner merges.
- Netlify sites: the deploy preview is not always a `netlify/<site>/deploy-preview` check on the PR (some sites only post the "Header rules" / "Redirect rules" checks). The URL is then `https://deploy-preview-<PR#>--<netlify-site-name>.netlify.app`; the Netlify site name is in those checks' links and can differ from the repo name. Open it and confirm `<meta name="generator" content="Astro v7…">` (when the site emits it). Netlify forms (`data-netlify="true"`) are detected from the built HTML, so check the `<form>` tags are unchanged in the diff.
- The preview injects Netlify's drawer iframe; a site with a strict `frame-src` CSP logs a CSP error for it. Preview-only, ignore.
