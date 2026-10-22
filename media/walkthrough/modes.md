# Two ways to keep settings.json in Git

**Generated settings.json** (recommended)

- The team commits `.vscode/settings.shared.json`.
- `settings.json` is generated, and Git ignores it and `settings.local.json`.
- `git status` stays clean, pulls are never blocked.
- Teammates without the extension copy `settings.shared.json` to `settings.json`.

**Keep settings.json committed**

- Nothing changes for the team: `settings.json` stays the committed file.
- Your `settings.local.json` is applied to it, and Git is told to skip the file
  (`git update-index --skip-worktree`), so your values never show in `git status`.
- The cost: while the file is skipped, `git pull` stops if the team changed it. The
  extension notices after a fetch and offers **Unhide to Pull**: the file goes back to the
  committed version, you pull, and your settings come back on their own.
- To change the team's settings, use **Unhide settings.json to Commit a Team Change**.

Setup shows every file it will write as a diff first.
