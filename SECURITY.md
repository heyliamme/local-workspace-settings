# Security policy

The extension reads and writes the settings files of the folders you open
(`.vscode/settings.json`, `settings.shared.json`, `settings.local.json`, and a workspace's
`.code-workspace` file), keeps backups of them in its own storage, runs the `git` command
line in those folders, and may edit `.gitignore` or `.git/info/exclude` when you ask it to.

Bugs that write outside those files and the extension's storage, lose or corrupt a setting,
run git (or anything else) in a folder that isn't trusted, let a repository's content run
code, or put personal settings into something Git would commit without you asking are taken
seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/local-workspace-settings/security/advisories/new),
not public issues. Include steps to reproduce, with private paths and tokens redacted. You
should hear back within a week.

## Scope

In scope: writes to unexpected paths (through symbolic links, file names or workspace
files), settings files left broken or with unrelated settings changed, script execution or
HTML injection in the overview from settings content, git being run in Restricted Mode, and
any data sent off the machine (the extension makes no network requests).

Out of scope: what VS Code or another extension does with a setting once it is merged, and
Git's own behaviour around `skip-worktree`, which the README describes.
