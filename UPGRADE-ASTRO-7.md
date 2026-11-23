# Upgrading a site from Astro 5 to Astro 7

Recipe from the pilot (a static blog: content collections, `astro:assets`, Tailwind 4 via `@tailwindcss/vite`, `@astrojs/rss`, `@astrojs/sitemap`, satori OG images, GitHub Pages). Took about an hour; most of it was the output diff.

Official guides: [v6](https://docs.astro.build/en/guides/upgrade-to/v6/), [v7](https://docs.astro.build/en/guides/upgrade-to/v7/). Go straight from 5 to 7; no need to stop at 6.

## 0. Prep

- Dependabot opens one PR per Astro version (e.g. `7.4.7`, then `7.4.13`). Don't build on them: start a fresh branch from the default branch, then close both Dependabot PRs pointing at yours. Major bumps aren't auto-merged by this CI, but a human-owned branch is clearer.
- Node: Astro 7.4 needs **Node ≥ 22.23** (`engines`). This CI defaults to 24 (or `.nvmrc` / `.node-version`). Check the deploy target too (GitHub Pages `withastro/action` with `node-version: 24`; on Netlify set `NODE_VERSION` ≥ 22.23 or 24).

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

What a real problem looks like: missing/extra page, changed title or heading, changed Markdown prose (Sätteri vs remark: watch for smart quotes, footnotes, tables, autolinks), whitespace vanishing between inline elements (you forgot `compressHTML: true`), missing `[data-astro-image…]` CSS if the site uses `image.responsiveStyles`.

## 5. PR

- Push, open the PR, close the Dependabot Astro PRs as superseded.
- This repo's CI (`astro check` when `@astrojs/check` is installed, build, smoke test of every sitemap page + internal links) must be green.
- In the PR body: the breaking changes that applied, the result of each check above, the pages a human should look at (pages with inline SVG, image grids, client scripts).
- Merging deploys: the site owner merges.
