// Read-only documents for previews and diffs: what setup would write, the committed
// settings, and the shared layer next to the merge.
import * as path from 'path';
import * as vscode from 'vscode';

export const SCHEME = 'local-workspace-settings';

export class Previews implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private n = 0;
  private readonly reg: vscode.Disposable;

  constructor() {
    this.reg = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  /** A document with the given text, named like `file` so it gets JSON with comments highlighting. */
  put(label: string, file: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(file)}`, query: `${label}-${++this.n}` });
    this.docs.set(uri.toString(), text);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  /** Closes the preview tabs this provider opened. */
  async closeAll(): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
      const i = t.input;
      if (i instanceof vscode.TabInputTextDiff) return i.original.scheme === SCHEME || i.modified.scheme === SCHEME;
      if (i instanceof vscode.TabInputText) return i.uri.scheme === SCHEME;
      // The multi-file diff editor (vscode.changes) has no typed input in this API version.
      return /^Set up/.test(t.label);
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  dispose() {
    this.reg.dispose();
    this.emitter.dispose();
  }
}
