# How it works

VS Code reads exactly one settings file per folder: `.vscode/settings.json`. It has no
`settings.local.json` of its own ([microsoft/vscode#40233](https://github.com/microsoft/vscode/issues/40233)).

So this extension keeps two layers and writes their merge into the file VS Code reads:

| Layer | Who | In Git |
| --- | --- | --- |
| The team's settings | everyone | committed |
| `.vscode/settings.local.json` | you | ignored |

Your values win. Objects such as `files.exclude` merge key by key; lists replace the
team's list unless you choose otherwise. `null` removes a team setting for you.

When something writes to `settings.json` itself (the Settings editor, Peacock, the Python
extension picking an interpreter), the extension notices which settings changed and moves
them to your local file, or asks you where they belong.

Every write is backed up first. **Undo Last Change** puts the files back.
