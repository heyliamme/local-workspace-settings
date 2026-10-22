// The overview: every setting of a folder with where it comes from, and the moves between
// the team's file and yours. Read-only in Restricted Mode.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { Manager } from './manager';
import type { HostCommand, State, ToHost, ToWebview } from './protocol';

export const VIEW_TYPE = 'localWorkspaceSettings';

const COMMANDS: Record<HostCommand, string> = {
  initialise: 'localWorkspaceSettings.initialise',
  regenerate: 'localWorkspaceSettings.regenerate',
  openShared: 'localWorkspaceSettings.openShared',
  openLocal: 'localWorkspaceSettings.openLocal',
  openSettings: '',
  showDiff: 'localWorkspaceSettings.showDiff',
  undo: 'localWorkspaceSettings.undo',
  restoreBackup: 'localWorkspaceSettings.restoreBackup',
  gitIgnore: 'localWorkspaceSettings.gitIgnore',
  unhideForPull: 'localWorkspaceSettings.unhideForPull',
  unhideForTeamChange: 'localWorkspaceSettings.unhideForTeamChange',
  hide: 'localWorkspaceSettings.hide',
  manageTrust: 'workbench.trust.manage',
};

export interface PanelActions {
  openSettings(id?: string): Promise<void>;
}

export class OverviewPanel {
  static current: OverviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private selected: string | undefined;
  private posting = 0;
  private disposed = false;

  static show(ctx: vscode.ExtensionContext, mgr: Manager, actions: PanelActions, select?: string) {
    if (OverviewPanel.current) {
      OverviewPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (select) OverviewPanel.current.selected = select;
      OverviewPanel.current.refresh();
      return OverviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Workspace Settings', vscode.ViewColumn.Active, OverviewPanel.options(ctx));
    const p = new OverviewPanel(panel, ctx, mgr, actions);
    if (select) p.selected = select;
    return p;
  }

  static options(ctx: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')] };
  }

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext,
    private readonly mgr: Manager,
    private readonly actions: PanelActions,
  ) {
    OverviewPanel.current = this;
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    panel.webview.options = OverviewPanel.options(ctx);
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: ToHost) => this.onMessage(m)),
      panel.onDidChangeViewState((e) => e.webviewPanel.visible && this.refresh()),
    );
  }

  refresh() {
    this.post().catch((e) => this.mgr.log.warn(`Overview: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The panel can be closed while a move or a refresh is still running. */
  private send(m: ToWebview) {
    if (this.disposed) return;
    try {
      void this.panel.webview.postMessage(m).then(undefined, () => undefined);
    } catch {
      /* disposed in the meantime */
    }
  }

  async state(): Promise<State> {
    const targets = [];
    for (const e of this.mgr.entries.values()) targets.push(await this.mgr.view(e));
    if (!this.selected || !targets.some((t) => t.id === this.selected)) this.selected = (targets.find((t) => t.mode) ?? targets[0])?.id;
    return { trusted: this.mgr.trusted, targets, selected: this.selected };
  }

  private async post() {
    if (!this.ready || this.disposed) return;
    const n = ++this.posting;
    const state = await this.state();
    if (n === this.posting) this.send({ type: 'state', state });
  }

  private async onMessage(m: ToHost) {
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          await this.post();
          break;
        case 'select':
          this.selected = m.id;
          await this.post();
          break;
        case 'move': {
          const e = this.mgr.entries.get(m.target);
          if (!e) break;
          this.send({ type: 'busy', busy: true });
          try {
            await this.mgr.move(e, [{ op: m.op, key: m.key }]);
          } finally {
            this.send({ type: 'busy', busy: false });
          }
          break;
        }
        case 'sort': {
          const e = this.mgr.entries.get(m.target);
          if (e && this.mgr.guard()) await this.mgr.sort(e, m.key, m.route);
          break;
        }
        case 'command': {
          if (!(m.command in COMMANDS)) break;
          if (m.command === 'openSettings') await this.actions.openSettings(m.target);
          else if (m.command === 'manageTrust') await vscode.commands.executeCommand(COMMANDS.manageTrust);
          else await vscode.commands.executeCommand(COMMANDS[m.command], m.target);
          await this.post();
          break;
        }
      }
    } catch (e) {
      if (this.disposed) return;
      void vscode.window.showErrorMessage(`Local Workspace Settings: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private html() {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const asset = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', f));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource}; img-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Workspace Settings</title>
</head>
<body>
<div id="app" class="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (OverviewPanel.current === this) OverviewPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
