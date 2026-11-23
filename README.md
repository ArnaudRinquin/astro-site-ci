# astro-site-ci

Shared GitHub Actions for my Astro sites.

- `.github/workflows/astro-site.yml` — reusable PR CI: install (frozen), `astro check` if `@astrojs/check` is present, build, browser-free smoke test, offline internal link check, then Dependabot auto-merge (minor/patch squash-merged; majors get a "major: needs Arnaud" comment).
- `smoke/` — composite action + zero-dep `smoke.mjs` (serves `dist/`, checks every sitemap URL: 200, `<title>`, Umami snippet; checks every internal `href`/`src`/`srcset`). Run locally: `node smoke/smoke.mjs --dist dist [--umami false] [--ignore '^/other-project/']`.

Caller (`.github/workflows/ci.yml`):

```yaml
name: ci
on:
  pull_request:
    paths-ignore: ['*.md', 'docs/**']
  workflow_dispatch:
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
permissions:
  contents: write
  pull-requests: write
  actions: write
jobs:
  ci:
    uses: ArnaudRinquin/astro-site-ci/.github/workflows/astro-site.yml@v1
    # with: { umami: false, ignore-links: '^/foo/', deploy-workflow: deploy.yml }
```

Notes: merges by `GITHUB_TOKEN` don't fire `push` workflows, hence `deploy-workflow` (GitHub Pages sites). Netlify deploys via its own webhook, unaffected. Dependabot PRs touching `.github/workflows/` can't be merged with `GITHUB_TOKEN` (no `workflows` scope).
