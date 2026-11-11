# claude-mods

Claude Code mods. There is one: [`delegate`](mods/delegate/README.md), the orchestration mod. The main loop only
delegates, and each delegation is routed by model and by effort. Other mods come back later, one at a time.

## Installing

`.claude-plugin/marketplace.json` lists the mod as `"source": "./mods/delegate"`, so the repository is the
marketplace. From another machine:

```sh
/plugin install delegate --marketplace cdeust/claude-mods
```

On this machine a folder marketplace reads the mod from the checkout, with no copy:
`claude plugin marketplace add <this folder>`, then `/plugin install delegate` and `/reload-plugins` after an edit.

Without write access to `settings.json`, load it by directory (nothing is written; it is registered for the
session as `delegate@inline`):

```sh
claude --plugin-dir /path/to/claude-mods/mods/delegate
```

The options (`main_mode`, `main_allow`) live in `settings.json` under `pluginConfigs`; the defaults are right
without them (`block`, empty). `claude plugin list` shows the mod under "Session-only plugins" with `Status: loaded`.

The marketplace also lists `superpowers` (third-party, obra/superpowers, MIT), pinned to v7.0.0 `bb92a77`; it is
not a mod of this repository.

## Developing

```sh
claude plugin validate mods/delegate
claude plugin test mods/delegate
cd mods/delegate && npx -y -p typescript@5.6.3 tsc -p . --noEmit
```

`tsc` needs the engine to have loaded the mod once (it lays `.claude-plugin/types/`); keep `--noEmit`, since a plain
`tsc -p .` writes `.js` files beside the sources. For hot reload in a session, link the mod into that session's
`~/.claude/dev-mods/<session>/` folder; the engine watches the folder a link names.

`ci.json` is the pipeline's contract (`.github/workflows/pipeline.yml`); its commands validate and test the mod.

`docs/verification/` holds the evidence of past pull requests, including those of mods since removed.

## Releasing

The version is `version` in `mods/delegate/.claude-plugin/plugin.json`. After a merge whose five test categories
pass, the pipeline's `tag` job pushes `delegate/v<version>` (`ci.json` `release_packages`) with the
`RELEASE_TAG_SSH_KEY` deploy key. That push starts `.github/workflows/release.yml`, which checks out the tag, fails
unless the tag equals `delegate/v` plus the manifest's version at that commit, runs `claude plugin validate` and
`claude plugin test`, and publishes a GitHub Release with `delegate-<version>.tar.gz` (the committed
`mods/delegate` tree; the same git and gzip rebuild it byte for byte) and its `.sha256`. The notes list the commit subjects under
`mods/delegate` since the previous `delegate/v*` tag. To release a tag that already exists, run the workflow by
hand (Actions, Release, Run workflow) with `tag` set to it, e.g. `delegate/v0.3.2`; nothing is re-tagged.
