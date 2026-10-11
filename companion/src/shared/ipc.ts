/** IPC between the main process and the panel renderer. */

import type {
  BoardsResponse,
  DeleteRequest,
  DrawRequest,
  DrawResponse,
  MutateResponse,
  ReadResponse,
  SessionsResponse,
  UpdateRequest,
} from '../protocol';
import type { Region } from '../server/contract';
import type { StrokeEvent } from '../voice/types';

/** Requests main sends to the renderer, which owns the Excalidraw scene. */
export interface BoardOps {
  read: { args: { board: string; region?: Region }; result: ReadResponse };
  draw: { args: { board: string; req: DrawRequest; batchId: string }; result: DrawResponse };
  update: { args: { board: string; req: UpdateRequest; batchId: string }; result: MutateResponse };
  remove: { args: { board: string; req: DeleteRequest; batchId: string }; result: MutateResponse };
  png: { args: { board: string; region?: Region; maxEdge: number }; result: Uint8Array };
  /** Makes `board` the visible board. */
  show: { args: { board: string }; result: void };
  /** Builds what Send hands over, from the visible board. */
  payload: { args: Record<string, never>; result: SendPayload };
  /** Forgets the stroke log and clips after a Send that used them. */
  resetSession: { args: Record<string, never>; result: void };
  /** Writes pending scene and notes saves to disk. */
  flush: { args: Record<string, never>; result: void };
}

export type BoardOpName = keyof BoardOps;

export interface BoardRequest<K extends BoardOpName = BoardOpName> {
  id: number;
  op: K;
  args: BoardOps[K]['args'];
}

export type BoardReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export interface SendPayload {
  boardName: string;
  /** PNG bytes, long edge 1400 px or less, with user strokes numbered. */
  png: Uint8Array;
  /** Full Excalidraw scene. */
  scene: unknown;
  notes: string;
  /** Board changes since the last Send, in ms from the session start. */
  strokes: StrokeEvent[];
  /** Voice clips, timed on the same clock as `strokes`. */
  segments: { name: string; data: Uint8Array; startMs: number; mimeType: string }[];
  /** The board's bounding box, for position words in the timeline. */
  bounds: { x: number; y: number; width: number; height: number };
  /** A written draft that leads the prompt. */
  text?: string;
  /** The draft this Send uses up. Main deletes it once the Send goes out. */
  draftId?: string;
}

/** A written draft with no sketch. */
export interface TextPayload {
  text: string;
  draftId?: string;
}

/** What Send hands to main from either mode. */
export type Outgoing = SendPayload | TextPayload;

export const isTextPayload = (p: Outgoing): p is TextPayload => !('png' in p);

/** The panel shows the board or the drafts. */
export type Mode = 'sketch' | 'write';

/** Notes wait until you send them; Ready drafts form the queue. */
export type DraftStatus = 'note' | 'ready';

/** Something written in Write mode, saved as `<dataDir>/drafts/<id>.json`. */
export interface Draft {
  id: string;
  body: string;
  status: DraftStatus;
  /** A board whose sketch goes out with this draft. */
  board?: string;
  /** Position in the Ready queue, lowest first. */
  rank: number;
  createdAt: number;
  updatedAt: number;
}

export type Theme = 'light' | 'dark';

export interface Settings {
  /** Global shortcut that shows and hides the panel. */
  hotkey: string;
  /** `fill` puts the draft in the prompt box; `submit` sends it at once. */
  deliveryMode: 'fill' | 'submit';
  openAtLogin: boolean;
  /** Global shortcut that opens a new note in Write mode. */
  captureHotkey: string;
}

export type SettingsResult = { ok: true; settings: Settings } | { ok: false; error: string; settings: Settings };

export interface MicrophoneAccess {
  granted: boolean;
  status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
}

export interface UpdateStatus {
  /** The running version. */
  version: string;
  /** `off` in development and test runs, where the app never updates itself. */
  state: 'off' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  /** The newer version being downloaded or ready to install. */
  available?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

/** Where Send can start a new Claude Code session. `copy` puts a start command on the clipboard. */
export type Launcher = 'ghostty' | 'terminal' | 'herdr' | 'copy';

export interface LaunchOptions {
  /** Launchers this Mac has, in menu order. `copy` is always last. */
  launchers: Launcher[];
  /** Project folders sessions ran in, most recent first. */
  recentProjects: string[];
}

export interface SendResult {
  ok: boolean;
  message: string;
}

/** One past Send, newest first in the history list. */
export interface HistoryEntry {
  /** The bundle id, also the folder name under `.feedback/sketches`. */
  id: string;
  sentAt: number;
  /** The board whose sketch went out. Absent for a written draft alone. */
  board?: string;
  /** The written draft that led the prompt. */
  text?: string;
  /** The session it went to, in words. */
  target: string;
  /** The bundle folder in the session's project. */
  dir: string;
  /** The prompt text Claude Code received. */
  draft: string;
  /** The board's notes when it was sent. */
  notes?: string;
}

export interface InitInfo {
  currentBoard: string;
  /** The user's home folder, for short paths. */
  home: string;
  prompt?: string;
  sessions: SessionsResponse;
  testMode: boolean;
  theme: Theme;
  settings: Settings;
  panelVisible: boolean;
  mode: Mode;
}

export type BoardEntry = BoardsResponse['boards'][number];

/**
 * What the board UI needs from its host. The Electron preload implements it,
 * and a browser client can implement it over the network.
 */
export interface BoardHost {
  listBoards(): Promise<BoardEntry[]>;
  loadBoard(name: string): Promise<{ scene: string | null; notes: string }>;
  saveBoard(name: string, json: string): Promise<void>;
  saveNotes(name: string, text: string): Promise<void>;
  /** Creates a board and returns its cleaned-up name. */
  createBoard(name: string): Promise<string>;
  renameBoard(from: string, to: string): Promise<string>;
  setCurrent(name: string): Promise<void>;
  send(payload: SendPayload): Promise<{ ok: boolean; message: string }>;
  onTheme(fn: (theme: Theme) => void): void;
}

/** A starting point for drafts: `<dataDir>/templates/<id>.md`. `{{name}}` marks a slot to fill. */
export interface Template {
  id: string;
  title: string;
  body: string;
}

/** What the preload script exposes as `window.companion`. */
export interface CompanionApi extends BoardHost {
  init(): Promise<InitInfo>;
  setTarget(sessionId: string | undefined): Promise<void>;
  /**
   * The handler answers with a whole reply. Errors thrown across the context
   * bridge lose their `code`, so the renderer catches them itself.
   */
  onRequest(handler: (req: BoardRequest) => Promise<BoardReply>): void;
  /** Tells main the board handler is listening. */
  ready(): void;
  onPrompt(fn: (prompt: string | undefined) => void): void;
  onSessions(fn: (s: SessionsResponse) => void): void;
  hidePanel(): void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<SettingsResult>;
  requestMicrophone(): Promise<MicrophoneAccess>;
  onOpenSettings(fn: () => void): void;
  onNewBoard(fn: () => void): void;
  /** Fires when the panel window shows or hides. */
  onVisibility(fn: (visible: boolean) => void): void;
  /** The last sends, newest first, each with its PNG. */
  listHistory(): Promise<(HistoryEntry & { png?: Uint8Array })[]>;
  /** Copies a past send onto a new board, a new note, or both. */
  restoreHistory(id: string): Promise<{ board?: string; draftId?: string }>;
  launchOptions(): Promise<LaunchOptions>;
  /** Asks for a project folder. Undefined when cancelled. */
  chooseFolder(): Promise<string | undefined>;
  send(payload: Outgoing): Promise<SendResult>;
  /** Writes the bundle into `cwd` and starts Claude Code there on it. */
  sendNew(payload: Outgoing, target: { cwd: string; via: Launcher }): Promise<SendResult>;
  /** Brings a session's terminal forward. */
  focusSession(sessionId: string): Promise<void>;
  getUpdate(): Promise<UpdateStatus>;
  checkForUpdate(): Promise<UpdateStatus>;
  /** Quits and installs a downloaded update. */
  installUpdate(): Promise<void>;
  onUpdate(fn: (status: UpdateStatus) => void): void;
  /** Remembers the mode for the next launch and the File menu. */
  setMode(mode: Mode): void;
  /** Fires when the capture shortcut, a menu or /write asks for a new note, with any starting text. */
  onNewNote(fn: (text?: string) => void): void;
  /** Ready drafts first by rank, then notes, newest first. */
  listDrafts(): Promise<Draft[]>;
  /** Creates or replaces a draft. */
  saveDraft(draft: Draft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  listTemplates(): Promise<Template[]>;
  /** Creates a template when `id` is absent, and returns it with its id. */
  saveTemplate(template: { id?: string; title: string; body: string }): Promise<Template>;
  deleteTemplate(id: string): Promise<void>;
}

export const CH = {
  init: 'app:init',
  listBoards: 'boards:list',
  loadBoard: 'boards:load',
  saveBoard: 'boards:save',
  saveNotes: 'notes:save',
  createBoard: 'boards:create',
  renameBoard: 'boards:rename',
  setCurrent: 'boards:current',
  send: 'panel:send',
  setTarget: 'sessions:target',
  request: 'board:request',
  reply: 'board:reply',
  ready: 'board:ready',
  prompt: 'panel:prompt',
  sessions: 'panel:sessions',
  theme: 'panel:theme',
  hide: 'panel:hide',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  mic: 'mic:request',
  openSettings: 'panel:open-settings',
  newBoard: 'panel:new-board',
  visibility: 'panel:visibility',
  historyList: 'history:list',
  historyRestore: 'history:restore',
  launchOptions: 'sessions:launch-options',
  chooseFolder: 'sessions:choose-folder',
  sendNew: 'panel:send-new',
  focusSession: 'sessions:focus',
  update: 'update:status',
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  setMode: 'panel:mode',
  newNote: 'panel:new-note',
  listDrafts: 'drafts:list',
  saveDraft: 'drafts:save',
  deleteDraft: 'drafts:delete',
  listTemplates: 'templates:list',
  saveTemplate: 'templates:save',
  deleteTemplate: 'templates:delete',
} as const;
