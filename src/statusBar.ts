// One status bar item: how settings are kept in Git here, and a warning when the merge is
// out of date, a file can't be read, settings wait to be sorted, or Git needs a hand.
import * as vscode from 'vscode';
import { cfg, type Manager } from './manager';
import type { TargetView } from './protocol';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('localWorkspaceSettings', vscode.StatusBarAlignment.Left, 20);
  private n = 0;

  constructor(private readonly m: Manager) {
    this.item.name = 'Local Workspace Settings';
    this.item.command = 'localWorkspaceSettings.openView';
  }

  async update() {
    const run = ++this.n;
    const entries = m(this.m);
    if (!cfg().get<boolean>('statusBar', true) || !entries.length) {
      this.item.hide();
      return;
    }
    const views: TargetView[] = [];
    for (const e of entries) views.push(await this.m.view(e).catch((err) => ({ id: e.t.id, name: e.t.name, kind: e.t.kind, mode: e.st?.mode, status: 'error' as const, message: String(err?.message ?? err), keys: [], unsorted: [], files: { settings: '', shared: '', local: '' }, hasLocalFile: false })));
    if (run !== this.n) return;
    const worst = (s: TargetView['status']) => views.filter((v) => v.status === s);
    const multi = views.length > 1;
    let text: string;
    let warn = false;
    let label: string;
    if (!this.m.trusted) {
      text = '$(shield) Local settings';
      label = 'Local workspace settings are paused in Restricted Mode';
    } else if (worst('error').length) {
      text = '$(error) Local settings';
      warn = true;
      label = 'Local workspace settings: a settings file can’t be read';
    } else if (worst('pending').length) {
      const n = views.reduce((a, v) => a + v.unsorted.length, 0);
      text = `$(warning) Local settings: ${n} unsorted`;
      warn = true;
      label = `Local workspace settings: ${n} changed setting${n === 1 ? '' : 's'} not sorted yet`;
    } else if (views.some((v) => v.git?.upstreamChanged)) {
      text = '$(repo-pull) Local settings: unhide to pull';
      warn = true;
      label = 'Local workspace settings: the team changed settings.json upstream';
    } else if (worst('unhidden').length) {
      text = '$(eye) settings.json unhidden';
      warn = true;
      label = 'Local workspace settings: settings.json shows the committed settings for Git';
    } else {
      const modes = new Set(views.map((v) => v.mode));
      const mode = modes.size > 1 ? 'mixed' : modes.has('committed') ? 'hidden' : 'generated';
      text = `$(layers) Local settings${multi ? '' : `: ${mode}`}`;
      label = `Local workspace settings in sync${multi ? ` in ${views.length} folders` : `, settings.json ${mode === 'hidden' ? 'committed with personal settings hidden' : 'generated'}`}`;
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    if (!this.m.trusted) md.appendMarkdown('**Paused in Restricted Mode.** Nothing is merged or written and git is not run until you trust this folder.\n\n');
    for (const v of views) {
      const mode = v.mode === 'committed' ? '`settings.json` committed, personal settings hidden with skip-worktree' : 'generated `settings.json` from `settings.shared.json` + `settings.local.json`';
      const local = v.keys.filter((k) => k.origin !== 'shared').length;
      md.appendMarkdown(`**${esc(v.name)}**: ${mode}. ${v.keys.length} settings, ${local} from your local file.`);
      if (v.message) md.appendMarkdown(`  \n$(warning) ${esc(v.message)}`);
      if (v.unsorted.length) md.appendMarkdown(`  \n$(warning) Not sorted yet: ${v.unsorted.map((u) => `\`${esc(u.key)}\``).join(', ')}`);
      if (v.git?.upstreamChanged) md.appendMarkdown('  \n$(repo-pull) The team changed settings.json upstream: unhide it to pull.');
      if (v.git?.notIgnored.length) md.appendMarkdown(`  \n$(info) Not ignored by Git yet: ${v.git.notIgnored.map((f) => `\`${esc(f)}\``).join(', ')}`);
      md.appendMarkdown('\n\n');
    }
    md.appendMarkdown('Click to show the overview.');
    this.item.text = text;
    this.item.tooltip = md;
    this.item.accessibilityInformation = { label: `${label}. Show the overview`, role: 'button' };
    this.item.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose() {
    this.item.dispose();
  }
}

const m = (mgr: Manager) => mgr.active();
const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
