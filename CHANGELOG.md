# Changelog

## 0.1.0

First release.

- A git-ignored `.vscode/settings.local.json` merged over the team's settings into the
  `settings.json` VS Code reads. Local values win, objects merge key by key, lists replace
  (or append, prepend, union per setting), `null` removes a team setting and
  `{ "$replace": … }` replaces without merging. Comments and formatting are kept.
- Two Git modes, chosen at setup: a generated `settings.json` from a committed
  `settings.shared.json`, or a committed `settings.json` with personal settings hidden by
  `skip-worktree`, including a committed `.code-workspace` file's `settings` block.
- Setup suggests which settings are personal, previews every file as a diff, and offers the
  ignore rules (`.gitignore` or `.git/info/exclude`) and `git rm --cached` for a generated
  `settings.json`, each only after a click.
- Settings changed in `settings.json` by the Settings editor, another extension or by hand
  are moved to the local file (or the shared one, or asked about), by rule, by default or by
  a remembered answer. A setting changed in two places is a conflict you settle.
- Committed mode notices an upstream change to `settings.json` after a fetch and offers
  **Unhide to Pull**; personal settings come back on their own after the pull or after a
  team change is committed.
- Overview of every setting with its origin, values and moves between the files; status bar
  item with the mode and anything that needs attention.
- A backup before every write (last 20 per folder) with **Undo Last Change** and **Restore
  a Backup…**; atomic writes; malformed files never overwritten; no write loops.
- Multi-root workspaces, Remote / WSL / containers, CRLF and BOM files. Nothing is written
  and git never runs in Restricted Mode; trusting the folder merges right away.
- Sharing a change from `settings.json` (right away, or with **Move to Shared** afterwards)
  shares only what changed: personal entries of an object, or of a list that a rule appends
  to or joins, stay in the local file, and a stale local override can't bring the old value
  back.
- **Stop Using Local Settings Here…** turns local settings off for a folder (and clears
  `skip-worktree`); undoing the setup does the same and leaves the files as they were.
- Generated mode pauses on a checkout without `settings.shared.json` (a branch from before
  the switch) instead of rewriting the committed `settings.json`. Layer files that are
  symbolic links are never read.
- The shared and local files open as JSON with comments, with setting completions; a
  duplicate key is reported by name and line. Uses VS Code's `git.path`.
- With Workspace Config+ installed, a folder with `settings.shared.json` is not taken over
  automatically, and setup offers only the committed mode (both extensions use the same
  file names).
