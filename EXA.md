# Exa — Exasol Studio's engine fork of exa

This repository is a fork of [anomalyco/exa](https://github.com/anomalyco/exa)
(MIT license — see `LICENSE`, which is preserved unchanged). It powers the
**Exa** agent inside [Exasol Studio](https://github.com/Sheetaldharshan200/Exasol-studio),
which installs the engine from THIS repo's GitHub Releases as a managed
component. All credit for the engine belongs to the exa project; this
fork only carries a minimal branding patch series on top.

## Branching & release model

- `exa-main` — the release branch: upstream tag + the patch series below.
- Tags: `v<upstream-version>-exa.<patch-rev>` (e.g. `v1.18.12-exa.1`).
  Pushing a tag triggers `.github/workflows/exa-release.yml`, which builds
  every platform binary on one runner (the upstream build script
  cross-compiles via bun) and uploads assets with the SAME names upstream
  uses (`exa-darwin-arm64.zip`, `exa-linux-x64.tar.gz`, …), so
  Studio's installer needs only the repo + tag switched.
- Binary and asset names intentionally stay `exa` — Studio's installer,
  supervisor, and CLI shim depend on them; renaming buys nothing.

## Patch series (keep it MINIMAL — every patch must survive a rebase)

1. **oauth-page-branding** — `packages/core/src/oauth/page.ts`: the OAuth
   callback page shown after ChatGPT/Copilot sign-ins renders "Exa" instead
   of the upstream wordmark (user-visible strings + a simple original text
   mark). Upstream has no whitelabel option for this page; if one lands,
   drop this patch.

## Syncing with upstream

```sh
git remote add upstream https://github.com/anomalyco/exa  # once
git fetch upstream --tags
git checkout -b exa-rebase vX.Y.Z          # the new upstream tag
git cherry-pick <patch commits from exa-main>
# resolve, verify: bun install && bun ./packages/exa/script/build.ts --single
git branch -f exa-main exa-rebase && git push fork exa-main --force-with-lease
git tag vX.Y.Z-exa.1 && git push fork vX.Y.Z-exa.1   # CI releases
```

Then bump Exasol Studio: `verified_version` in `local_database.rs`,
`catalog.json`, and `ENGINE_TAG` in `ExaEnginePanel.tsx`.
