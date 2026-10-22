// Messages between the extension and the overview webview.
import type { KeyInfo, Mode, Route } from './core/index';

export interface TargetView {
  id: string;
  name: string;
  kind: 'folder' | 'workspace';
  /** Not set up yet: the overview offers setup. */
  mode?: Mode;
  status: 'ok' | 'error' | 'pending' | 'unhidden' | 'off' | 'restricted';
  message?: string;
  keys: KeyInfo[];
  /** Settings in the file VS Code reads that don't match the merge yet. */
  unsorted: { key: string; value: unknown }[];
  files: { settings: string; shared: string; local: string };
  hasLocalFile: boolean;
  git?: {
    /** committed mode: skip-worktree is set. */
    hidden?: boolean;
    unhidden?: 'pull' | 'team';
    upstreamChanged?: boolean;
    /** Ignore rules still missing, as the files that need them. */
    notIgnored: string[];
    /** generated mode: settings.json is still committed. */
    settingsTracked?: boolean;
  };
}

export interface State {
  trusted: boolean;
  targets: TargetView[];
  selected?: string;
}

export type HostCommand = 'initialise' | 'regenerate' | 'openShared' | 'openLocal' | 'openSettings' | 'showDiff' | 'undo' | 'restoreBackup' | 'gitIgnore' | 'unhideForPull' | 'unhideForTeamChange' | 'hide' | 'manageTrust';

export type ToHost =
  | { type: 'ready' }
  | { type: 'select'; id: string }
  | { type: 'move'; target: string; op: 'toLocal' | 'toShared' | 'removeOverride'; key: string }
  | { type: 'sort'; target: string; key: string; route: Exclude<Route, 'defer'> }
  | { type: 'command'; command: HostCommand; target?: string };

export type ToWebview = { type: 'state'; state: State } | { type: 'busy'; busy: boolean };
