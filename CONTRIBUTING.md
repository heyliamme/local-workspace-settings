# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

Settings files can hold private paths or tokens: redact them before pasting into an issue.

## Reporting a bug

Open an issue with what you did, what you expected and what you saw, and which Git mode the
folder uses. If a setting was lost or ended up in the wrong file, include the relevant part
of `settings.shared.json`, `settings.local.json` and `settings.json` before and after. A
copy of each file from before every change is in the extension's backups (**Restore a
Backup…** lists them).

## Running from source

Node 22 or newer, and Git.

```bash
git clone https://github.com/heyliamme/local-workspace-settings
cd local-workspace-settings
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host. It works on the folders
you open there, so open a scratch folder, not a project you care about.

## Tests

```bash
npm run typecheck
npm test
```

The unit tests run on the engine in `src/core` (no VS Code), always in temporary folders:

- `test/merge.test.mjs`: merge semantics (objects, lists and their rules, `null`,
  `$replace`) and the reverse (the smallest override that gives a result).
- `test/jsonc.test.mjs`: editing JSON with comments: what is kept, CRLF, BOM, workspace
  files, malformed input, large files.
- `test/engine.test.mjs`: the generated mode: setup and its preview, merging, routing
  changes made in `settings.json`, conflicts, defer and discard, no write loops, backups,
  undo, rotation, a file changed mid-merge, symbolic links, several folders.
- `test/git.test.mjs`: the committed mode against real temporary repositories:
  skip-worktree, an upstream change, unhide, pull and re-hide, a team change, a checkout,
  a `.code-workspace` file, ignore rules.
- `test/manifest.test.mjs`: the manifest, the notices, the webview's CSP, no network, and
  how git is run.

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile and
uses it as a person would, in three windows: a single folder in generated mode (setup with
its preview, the ignore rules, editing the local file, a setting changed in the Settings
editor, the overview's moves, a malformed file, undo, the light theme, Reload Window), a
multi-root workspace with a committed-mode clone (an upstream change, Unhide to Pull, a team
change), and Restricted Mode. Git never reads your configuration (`GIT_CONFIG_GLOBAL` points
at `/dev/null`). VS Code runs headless. Linux only, with `code` on your `PATH` (or set
`VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
E2E_SHOTS=images npm run test:e2e   # also retakes the README screenshots
```

Screenshots of failing steps land in the temporary folder it prints.

## Pull requests

Keep the engine in `src/core` free of `vscode` imports so it stays testable, add a test for
the behaviour you change, and run `npm run typecheck && npm test` before opening the PR.
