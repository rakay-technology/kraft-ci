# kraft-ci

Public CI compute for the **private** [`rakay-technology/kraft`](https://github.com/rakay-technology/kraft)
repository. Public repos get unlimited free GitHub Actions minutes, so the
whole pipeline runs here — while every shippable artifact lands on the
private repo. **No release, image, installer or source is stored here.**

| Built here (transit, ≤1 day) | Published there (permanent) |
|---|---|
| Server / email / dashboard / CLI tarballs | GitHub Release on `kraft` (private) |
| Desktop installers (zip, AppImage, deb, rpm) | Same private release, as attachments |
| Docker images (built by digest) | `ghcr.io/rakay-technology/*` (private namespace) |
| CLI npm package | npmjs (public, as before) |

## Workflows

| Workflow | Trigger | Does |
|---|---|---|
| `CI` | dispatch (`ref`, default `main`) | typecheck + tests + webmail tests |
| `Component dispatch` | dispatch (`component`, `task`, `ref`) | one task for one component |
| `Release` | dispatch (`tag`, required) | gate → builds → **private** GitHub release + npm |
| `Docker images` | dispatch (`tag`, required) | gate → image builds → update E2E → route audit → manifests on **private** GHCR |
| `Release gate` | called / dispatch | typecheck + tests + real-daemon E2E |

## Release flow

1. Locally, in `kraft`: `bun run release patch publish` (or `minor`) — cuts the
   tag and pushes it to the **private** repo. The private repo's own
   tag-triggered workflows are disabled, so pushing the tag burns no quota.
2. Dispatch here with that tag:
   ```bash
   gh workflow run Release -R rakay-technology/kraft-ci -f tag=v0.7.10
   gh workflow run "Docker images" -R rakay-technology/kraft-ci -f tag=v0.7.10
   ```
3. Everything lands on the private repo. Build tarballs expire from here after
   1 day; digests likewise.

## Secrets (repo settings → Secrets and variables → Actions)

| Secret | What | Why |
|---|---|---|
| `KRAFT_PAT` | Fine-grained PAT, resource owner `rakay-technology`, repository access **only `kraft`**: Contents **read+write**, Packages **read+write**, Actions **read+write**, Metadata read-only | checkout private code, push GHCR images, create/upload private releases, delete transit artifacts |
| `NPM_TOKEN` | npm automation token | publish the CLI (token auth, works from any repo) |

The stock `GITHUB_TOKEN` is only used for this repo's own caches/artifacts.
