import type { BehaviorDocument, BehaviorDecision } from '../protocol';
/** IPC between the main process and the panel renderer. */

import type { BoardComments } from './board-comments';
import type { DraftReview, ReviewPayload, ReviewRect } from './review';
import type { EditResult, HistoryResult, ReviewEdit } from './review-edit';
import type {
  BoardLayout,
  SessionHost,
  BoardsResponse,
  DeleteRequest,
  DrawRequest,
  DrawResponse,
  Initiative,
  InitiativeFolder,
  InitiativeRevision,
  InitiativeSummary,
  MutateResponse,
  OutputRecord,
  PrototypeFidelity,
  ReadResponse,
  SessionMode,
  SessionsResponse,
  UpdateRequest,
} from '../protocol';
import type { Region } from '../server/contract';
import type { StrokeEvent } from '../voice/types';
import type { Decision, ItemsDoc } from './items';

export type { Decision } from './items';

/** Requests main sends to the renderer, which owns the Excalidraw scene. */
export interface BoardOps {
  read: { args: { board: string; region?: Region }; result: ReadResponse };
  draw: { args: { board: string; req: DrawRequest; batchId: string }; result: DrawResponse };
  update: { args: { board: string; req: UpdateRequest; batchId: string }; result: MutateResponse };
  remove: { args: { board: string; req: DeleteRequest; batchId: string }; result: MutateResponse };
  png: { args: { board: string; region?: Region; maxEdge: number }; result: Uint8Array };
  /** Makes `board` the visible board. A tab switch leaves the mode to the renderer. */
  show: { args: { board: string; fromSwitch?: boolean }; result: void };
  /** Builds what Send hands over, from the visible board. */
  payload: { args: Record<string, never>; result: SendPayload };
  /** Forgets the stroke log and clips after a Send that used them. */
  resetSession: { args: Record<string, never>; result: void };
  /** Writes pending scene and notes saves to disk. */
  flush: { args: Record<string, never>; result: void };
  /** Sets a board's layout. */
  layout: { args: { board: string; layout: BoardLayout }; result: void };
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
  /** The pictures the draft text references, as `att:<id>`. */
  images?: DraftImage[];
  /** The project-relative file the draft was opened from. The prompt asks Claude to apply the draft to it. */
  sourcePath?: string;
  /** Comments pinned to an HTML file. The prompt points Claude at review.md. */
  review?: ReviewPayload;
  /** Comments pinned to the board. The prompt points Claude at comments.md. */
  comments?: BoardComments;
}

/** A picture a draft carries, as the Send hands it over. */
export interface DraftImage {
  id: string;
  /** A data URL: png, jpeg, webp or gif. */
  data: string;
}

/** A written draft with no sketch. */
export interface TextPayload {
  text: string;
  draftId?: string;
  /** The pictures the text references, as `att:<id>`. */
  images?: DraftImage[];
  /** The project-relative file the draft was opened from. The prompt asks Claude to apply the draft to it. */
  sourcePath?: string;
  /** Comments pinned to an HTML file. The prompt points Claude at review.md. */
  review?: ReviewPayload;
}

/** What Send hands to main from either mode. */
export type Outgoing = SendPayload | TextPayload;

export const isTextPayload = (p: Outgoing): p is TextPayload => !('png' in p);

/** The panel shows the board, the drafts, the active session's items, or the initiatives. */
export type Mode = 'sketch' | 'write' | 'review' | 'initiative';

/** An initiative with its revisions, newest first, as the Initiative view shows it. */
export interface InitiativeDetail {
  initiative: Initiative;
  history: InitiativeRevision[];
}

/** What the panel changes in a brief. Main records it as the PM's revision. */
export interface InitiativePatch {
  revision: number;
  understanding?: string;
  decisions?: string[];
  open?: string[];
  folders?: InitiativeFolder[];
}

/** A conflict carries the brief as it is now, so the view can show it. */
export type InitiativeSaveResult = { ok: true; detail: InitiativeDetail } | { ok: false; message: string; detail?: InitiativeDetail };

/** Notes wait until you send them; Ready drafts form the queue. */
export type DraftStatus = 'note' | 'ready';

/** Something written in Write mode, saved as `<dataDir>/drafts/<id>.json`. */
export interface Draft {
  id: string;
  body: string;
  status: DraftStatus;
  /** The name the list shows, from `agent-brief note`. Absent, the list shows the body's first line. */
  title?: string;
  /** A board whose sketch goes out with this draft. */
  board?: string;
  /** The Claude Code session this note is filed under. Absent for a note in the Notes tab. */
  sessionId?: string;
  /** Pictures pasted into the draft, by id. Each is a data URL, long edge 1600 px or less. The body references one as `![alt](att:<id>)`. */
  attachments?: Record<string, string>;
  /** The output file this draft was opened from, relative to the session's project. Send asks Claude to apply the draft to it. */
  source?: DraftSource;
  /** Set when the draft reviews a session's HTML file. The body is the overall note. */
  review?: DraftReview;
  /** Position in the Ready queue, lowest first. */
  rank: number;
  createdAt: number;
  updatedAt: number;
}

/** Where a draft came from, when it is a copy of a session's output file. */
export interface DraftSource {
  path: string;
}

export type Theme = 'light' | 'dark';

/** `system` follows macOS; the others pin the panel to one theme. */
export type Appearance = 'system' | Theme;

export interface Settings {
  /** Global shortcut that shows and hides the panel. */
  hotkey: string;
  /** `fill` puts the draft in the prompt box; `submit` sends it at once. */
  deliveryMode: 'fill' | 'submit';
  openAtLogin: boolean;
  /** Global shortcut that opens a new note in Write mode. */
  captureHotkey: string;
  appearance: Appearance;
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
  /** The user asked to update, so the app asks to restart once the download finishes. */
  restart?: boolean;
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
  /** The session it went to. Absent for a new session or the clipboard. */
  sessionId?: string;
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
  /** Moves a board other than the current one to the Trash. */
  deleteBoard(name: string): Promise<void>;
  setCurrent(name: string): Promise<void>;
  /** Takes a board out of a session's brief. The board itself stays. */
  detachBoard(sessionId: string, name: string): Promise<void>;
  /** Files boards under a session, out of Unfiled or any other session. */
  moveBoards(names: string[], sessionId: string): Promise<void>;
  send(payload: SendPayload): Promise<{ ok: boolean; message: string }>;
  onTheme(fn: (theme: Theme) => void): Subscription;
}

/** A starting point for drafts: `<dataDir>/templates/<id>.md`. `{{name}}` marks a slot to fill. */
export interface Template {
  id: string;
  title: string;
  body: string;
}

/** A subscription may provide cleanup; older host adapters can keep returning void. */
export type Subscription = void | (() => void);

/** What the preload script exposes as `window.companion`. */
/** A new note main asks for: its starting text and, from /write, the id main records for the session. */
export interface NewNote {
  text?: string;
  id?: string;
  /** The session the note is filed under, when /write or the Write button opened it for one. */
  sessionId?: string;
  /** Set when the note is a copy of an output file the user opened from the Outputs list. */
  source?: DraftSource;
  /** Set when the note reviews an HTML output the user opened from the Outputs list. */
  review?: DraftReview;
}

/** A note /write reopens, with the session to file it under when it has none. */
export interface OpenDraft {
  id: string;
  sessionId?: string;
}

/** What a tab switch opened: the session's note, or its board. */
export type SwitchResult = { draftId: string } | { board: string };

/** One Claude Code session's latest brief, for switching between them. */
export interface SessionBriefEntry {
  sessionId: string;
  /** The session's title, or its folder. */
  title: string;
  /** Where the session ran. */
  cwd?: string;
  board?: string;
  draftId?: string;
  /** Which one the session opened last. */
  last?: 'board' | 'draft';
  /** When the session last used it, in ms since the epoch. */
  at: number;
  /** The session is still registered with the app. */
  isLive: boolean;
  /** The session is the Send target. */
  isTarget: boolean;
  /** Its board or note holds something not sent yet. */
  hasContent: boolean;
  /** The user asked Claude to keep an items file for this session. */
  trackItems?: boolean;
  /** The live session's mode, mirrored from the mod. Absent in default mode. */
  mode?: SessionMode;
  /** The prototype fidelity, present only with `mode: 'prototype'`. */
  fidelity?: PrototypeFidelity;
  /** Where the session ran, kept for ended sessions too. */
  host?: SessionHost;
  /** For an ended session with a known folder: `cd <cwd> && claude --resume <sessionId>`. */
  resume?: string;
}

/** A session's items file as the panel shows it. */
export interface ItemsDocInfo {
  sessionId: string;
  /** `<cwd>/.feedback/items/<sessionId>.md`. */
  path: string;
  /** False until Claude writes the file. */
  exists: boolean;
  doc: ItemsDoc;
}

/** A session's outputs file as the panel shows it. */
export interface OutputsInfo {
  sessionId: string;
  /** `<cwd>/.feedback/outputs/<sessionId>.json`. */
  path: string;
  /** False until the mod writes the file. */
  exists: boolean;
  /** Well-formed records, dismissed ones left out, declared first and newest on top. */
  outputs: OutputRecord[];
}

export interface CompanionApi extends BoardHost {
  init(): Promise<InitInfo>;
  setTarget(sessionId: string | undefined): Promise<void>;
  /**
   * The handler answers with a whole reply. Errors thrown across the context
   * bridge lose their `code`, so the renderer catches them itself.
   */
  onRequest(handler: (req: BoardRequest) => Promise<BoardReply>): Subscription;
  /** Tells main the board handler is listening. */
  ready(): void;
  onPrompt(fn: (prompt: string | undefined) => void): Subscription;
  onSessions(fn: (s: SessionsResponse) => void): Subscription;
  hidePanel(): void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<SettingsResult>;
  requestMicrophone(): Promise<MicrophoneAccess>;
  onOpenSettings(fn: () => void): Subscription;
  onNewBoard(fn: () => void): Subscription;
  /** Fires when the panel window shows or hides. */
  onVisibility(fn: (visible: boolean) => void): Subscription;
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
  /** Writes the bundle into `cwd` and copies a prompt with absolute paths, for pasting into a session by hand. */
  copyPrompt(payload: Outgoing, cwd: string): Promise<SendResult>;
  /** Where live sessions sit in their terminal, such as `herdr #16`, by session id. */
  sessionPlaces(): Promise<Record<string, string>>;
  /** Brings a session's terminal forward. */
  focusSession(sessionId: string): Promise<void>;
  getUpdate(): Promise<UpdateStatus>;
  /** Checks, downloads and restarts into a newer build in one step. */
  updateNow(): Promise<UpdateStatus>;
  /** Quits and installs a downloaded update. */
  installUpdate(): Promise<void>;
  onUpdate(fn: (status: UpdateStatus) => void): Subscription;
  /** Remembers the mode for the next launch and the File menu. */
  setMode(mode: Mode): void;
  /** Fires when the capture shortcut, a menu or /write asks for a new note, with any starting text and the id main chose. */
  onNewNote(fn: (note: NewNote) => void): Subscription;
  /** Fires when /write reopens a session's note. */
  onOpenDraft(fn: (open: OpenDraft) => void): Subscription;
  /** Fires when main saved a draft the panel did not make, such as a note from `agent-brief note`. */
  onDraftsChanged(fn: () => void): Subscription;
  /** Puts rich text and its plain form on the clipboard in one write. */
  copyRich(clip: { html: string; text: string }): Promise<void>;
  /** Each tracked session's latest brief, newest first. */
  listBriefs(): Promise<SessionBriefEntry[]>;
  /** Fires when a brief, a session or the Send target changes. */
  onBriefs(fn: (briefs: SessionBriefEntry[]) => void): Subscription;
  /** Makes the session the Send target, when it is still running, and opens its brief. The renderer picks the mode. */
  switchBrief(sessionId: string): Promise<SwitchResult>;
  /** Clears the Send target and makes Unfiled's board current. The renderer switches to it. */
  openUnfiled(): Promise<{ board: string }>;
  /** Stops tracking a session's brief. Its board and note stay. */
  forgetBrief(sessionId: string): Promise<void>;
  /** Ready drafts first by rank, then notes, newest first. */
  listDrafts(): Promise<Draft[]>;
  /** Creates or replaces a draft. */
  saveDraft(draft: Draft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  listTemplates(): Promise<Template[]>;
  /** Creates a template when `id` is absent, and returns it with its id. */
  saveTemplate(template: { id?: string; title: string; body: string }): Promise<Template>;
  deleteTemplate(id: string): Promise<void>;
  /** Turns item tracking on or off for a session. The brief list and GET /sessions/:id follow. */
  setTracking(sessionId: string, on: boolean): Promise<void>;
  /** The session's items file, parsed. Undefined for a session the app does not know. */
  readItems(sessionId: string): Promise<ItemsDocInfo | undefined>;
  /** Fires when a tracked session's items file changes on disk. */
  onItems(fn: (info: ItemsDocInfo) => void): Subscription;
  /** Appends the decisions as `You:` lines in the file and returns the prompt text that reports them. */
  saveDecisions(sessionId: string, decisions: Decision[]): Promise<{ draft: string }>;
  /** Starts a terminal in the ended session's folder running its resume command. `copy` puts the command on the clipboard. */
  resumeSession(sessionId: string, via: Launcher): Promise<SendResult>;
  /** Opens a file an item names on an `Out:` line. Rejects a path outside the session's folder or one that does not exist. */
  openItemOutput(sessionId: string, path: string): Promise<void>;
  /** The session's outputs file, parsed. Undefined for a session the app does not know. */
  readOutputs(sessionId: string): Promise<OutputsInfo | undefined>;
  /** Fires when a live session's outputs file changes on disk, or a dismissal changes the list. */
  onOutputs(fn: (info: OutputsInfo) => void): Subscription;
  /**
   * Opens an output. A markdown file opens as a note filed under the session, with `source` set,
   * reusing the note already opened from it. Other files open in their app, after the same checks
   * as `openItemOutput`. An http(s) URL opens in the browser.
   */
  openOutput(sessionId: string, ref: string): Promise<void>;
  /** Hides the row until the mod writes that output again. */
  dismissOutput(sessionId: string, ref: string): Promise<void>;
  /** Opens an output file in its default app, even one the panel can open itself. */
  openOutputElsewhere(sessionId: string, ref: string): Promise<void>;
  /** The address the review pane loads a session's HTML file from. */
  readBehavior(sessionId: string, path: string): Promise<BehaviorDocument>;
  decideBehavior(sessionId: string, path: string, decision: BehaviorDecision): Promise<BehaviorDocument>;
  onBehaviorChanged(fn: () => void): () => void;
  reviewUrl(sessionId: string, path: string): Promise<string>;
  /** Applies a review pane edit to the HTML file. `version` is the file's as the page loaded it. */
  reviewEdit(sessionId: string, path: string, version: string, edit: ReviewEdit): Promise<EditResult>;
  reviewUndo(sessionId: string, path: string): Promise<HistoryResult>;
  reviewRedo(sessionId: string, path: string): Promise<HistoryResult>;
  /** A JPEG data URL of part of the panel, in window pixels. Undefined when nothing was captured. */
  capturePanel(rect: ReviewRect): Promise<string | undefined>;
  /** Transcribes one voice clip with ffmpeg and yap. */
  transcribeClip(clip: { data: Uint8Array; mimeType: string }): Promise<{ text: string } | { error: string }>;
  /** Opens an http or https link in the browser. */
  openLink(url: string): Promise<void>;
  /** Every initiative, latest lastActiveAt first. */
  listInitiatives(): Promise<InitiativeSummary[]>;
  getInitiative(id: string): Promise<InitiativeDetail>;
  /** Writes an empty brief, `<title> brief.md`, in `folder`. */
  createInitiative(req: { title: string; folder: string }): Promise<InitiativeDetail>;
  /** Saves the PM's change against `patch.revision`. A stale revision answers `ok: false`. */
  updateInitiative(id: string, patch: InitiativePatch): Promise<InitiativeSaveResult>;
  /** Shows a file or folder in Finder. `~/` is allowed. */
  revealPath(path: string): Promise<void>;
  /** Fires when an initiative, its brief file or a session binding changes. */
  onInitiativesChanged(fn: (list: InitiativeSummary[]) => void): Subscription;
}

export const CH = {
  init: 'app:init',
  listBoards: 'boards:list',
  loadBoard: 'boards:load',
  saveBoard: 'boards:save',
  saveNotes: 'notes:save',
  createBoard: 'boards:create',
  renameBoard: 'boards:rename',
  deleteBoard: 'boards:delete',
  setCurrent: 'boards:current',
  detachBoard: 'boards:detach',
  moveBoards: 'boards:move',
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
  copyPrompt: 'panel:copy-prompt',
  sessionPlaces: 'sessions:places',
  focusSession: 'sessions:focus',
  update: 'update:status',
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  setMode: 'panel:mode',
  newNote: 'panel:new-note',
  openDraft: 'panel:open-draft',
  listBriefs: 'briefs:list',
  briefs: 'briefs:changed',
  switchBrief: 'briefs:switch',
  openUnfiled: 'briefs:openUnfiled',
  forgetBrief: 'briefs:forget',
  listDrafts: 'drafts:list',
  saveDraft: 'drafts:save',
  deleteDraft: 'drafts:delete',
  draftsChanged: 'drafts:changed',
  copyRich: 'clipboard:copy-rich',
  listTemplates: 'templates:list',
  saveTemplate: 'templates:save',
  deleteTemplate: 'templates:delete',
  setTracking: 'tracking:set',
  readItems: 'items:read',
  items: 'items:changed',
  saveDecisions: 'items:decide',
  openItemOutput: 'items:open-output',
  resumeSession: 'sessions:resume',
  readOutputs: 'outputs:read',
  outputs: 'outputs:changed',
  openOutput: 'outputs:open',
  dismissOutput: 'outputs:dismiss',
  openOutputElsewhere: 'outputs:open-elsewhere',
  readBehavior: 'behavior:read',
  decideBehavior: 'behavior:decide',
  behaviorChanged: 'behavior:changed',
  reviewUrl: 'review:url',
  reviewEdit: 'review:edit',
  reviewUndo: 'review:undo',
  reviewRedo: 'review:redo',
  capturePanel: 'review:capture',
  transcribeClip: 'review:transcribe',
  openLink: 'review:open-link',
  listInitiatives: 'initiatives:list',
  getInitiative: 'initiatives:get',
  createInitiative: 'initiatives:create',
  updateInitiative: 'initiatives:update',
  revealPath: 'initiatives:reveal',
  initiativesChanged: 'initiatives:changed',
} as const;

/** The explicit allowlist shared by main and preload. No arbitrary channel is exposed. */
type ApiMethod = keyof CompanionApi;
export type InvokeMethod = { [K in ApiMethod]: ReturnType<CompanionApi[K]> extends Promise<unknown> ? K : never }[ApiMethod];
export type EventMethod = { [K in ApiMethod]: K extends `on${string}` ? K : never }[ApiMethod];
export type SendMethod = Exclude<ApiMethod, InvokeMethod | EventMethod>;

export const IPC_INVOKE = {
  init: CH.init,
  listBoards: CH.listBoards,
  loadBoard: CH.loadBoard,
  saveBoard: CH.saveBoard,
  saveNotes: CH.saveNotes,
  createBoard: CH.createBoard,
  renameBoard: CH.renameBoard,
  deleteBoard: CH.deleteBoard,
  setCurrent: CH.setCurrent,
  detachBoard: CH.detachBoard,
  moveBoards: CH.moveBoards,
  send: CH.send,
  setTarget: CH.setTarget,
  getSettings: CH.getSettings,
  setSettings: CH.setSettings,
  requestMicrophone: CH.mic,
  listHistory: CH.historyList,
  restoreHistory: CH.historyRestore,
  launchOptions: CH.launchOptions,
  chooseFolder: CH.chooseFolder,
  sendNew: CH.sendNew,
  copyPrompt: CH.copyPrompt,
  sessionPlaces: CH.sessionPlaces,
  focusSession: CH.focusSession,
  getUpdate: CH.updateGet,
  updateNow: CH.updateCheck,
  installUpdate: CH.updateInstall,
  listBriefs: CH.listBriefs,
  switchBrief: CH.switchBrief,
  openUnfiled: CH.openUnfiled,
  forgetBrief: CH.forgetBrief,
  listDrafts: CH.listDrafts,
  copyRich: CH.copyRich,
  saveDraft: CH.saveDraft,
  deleteDraft: CH.deleteDraft,
  listTemplates: CH.listTemplates,
  saveTemplate: CH.saveTemplate,
  deleteTemplate: CH.deleteTemplate,
  setTracking: CH.setTracking,
  readItems: CH.readItems,
  saveDecisions: CH.saveDecisions,
  openItemOutput: CH.openItemOutput,
  resumeSession: CH.resumeSession,
  readOutputs: CH.readOutputs,
  openOutput: CH.openOutput,
  dismissOutput: CH.dismissOutput,
  openOutputElsewhere: CH.openOutputElsewhere,
  readBehavior: CH.readBehavior,
  decideBehavior: CH.decideBehavior,
  reviewUrl: CH.reviewUrl,
  reviewEdit: CH.reviewEdit,
  reviewUndo: CH.reviewUndo,
  reviewRedo: CH.reviewRedo,
  capturePanel: CH.capturePanel,
  transcribeClip: CH.transcribeClip,
  openLink: CH.openLink,
  listInitiatives: CH.listInitiatives,
  getInitiative: CH.getInitiative,
  createInitiative: CH.createInitiative,
  updateInitiative: CH.updateInitiative,
  revealPath: CH.revealPath,
} as const satisfies Record<InvokeMethod, string>;

export const IPC_SEND = {
  ready: CH.ready,
  hidePanel: CH.hide,
  setMode: CH.setMode,
} as const satisfies Record<SendMethod, string>;

export const IPC_EVENT = {
  onPrompt: CH.prompt,
  onSessions: CH.sessions,
  onTheme: CH.theme,
  onOpenSettings: CH.openSettings,
  onNewBoard: CH.newBoard,
  onUpdate: CH.update,
  onVisibility: CH.visibility,
  onNewNote: CH.newNote,
  onOpenDraft: CH.openDraft,
  onBriefs: CH.briefs,
  onDraftsChanged: CH.draftsChanged,
  onItems: CH.items,
  onOutputs: CH.outputs,
  onInitiativesChanged: CH.initiativesChanged,
  onBehaviorChanged: CH.behaviorChanged,
} as const satisfies Record<Exclude<EventMethod, 'onRequest'>, string>;
