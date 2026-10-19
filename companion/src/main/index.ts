import { BehaviorStore } from './behavior';
import { FeedbackStore } from './feedback';
import { FeedbackWorkspaces } from './feedback-workspace';
import { captureSession, FeedbackSnaps, offscreenCapture } from './feedback-snap';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  shell,
  systemPreferences,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { defaultSocketPath, SOCKET_ENV, type SessionsResponse } from '../protocol';
import type { BoardBackend } from '../server/contract';
import { createCompanionServer, type CompanionServer } from '../server/index';
import { BadRequest, parseInitiativeCreate, parseInitiativeUpdate } from '../server/validate';
import {
  CH,
  type BoardReply,
  type InitiativeDetail,
  type InitiativeSaveResult,
  type InitInfo,
  type Launcher,
  type LaunchOptions,
  type MicrophoneAccess,
  type Mode,
  type Outgoing,
  type SendResult,
  type Settings,
  type SwitchResult,
  type Theme,
} from '../shared/ipc';
import { newDraftId } from '../shared/drafts';
import { createBoardBackend } from './backend';
import { Briefs } from './briefs';
import { RendererBridge } from './bridge';
import { isTranslocated } from './cli-install';
import { createControls } from './controls';
import { DraftStore } from './drafts';
import { restoredBoardName, SendHistory } from './history';
import { expandHome, InitiativeStore } from './initiatives';
import { createInstalls } from './installs';
import { ItemsWatcher } from './items-watch';
import { trayMenuTemplate } from './menus';
import { Panel } from './panel';
import { Quitter } from './quit';
import { overlayFileFrom, REVIEW_SCHEME, ReviewRoots, serveReview } from './review-protocol';
import { rememberProjects, Sender } from './sender';
import { unfiledBoardChoice } from './session-briefs';
import { SessionFiles, webUrl, type Opener } from './session-files';
import { SessionModes } from './session-modes';
import { TemplateStore } from './templates';
import { Terminals } from './terminals';
import { Updater } from './updater';
import { BoardStore, cleanName, migrateData, StateFile } from './store';
import { mainIpc } from './ipc';
import { transcribeClip } from '../voice/compose';

const testMode = process.env.COMPANION_TEST === '1';

/** The release feed, as `publish` in electron-builder.yml names it. */
const RELEASES = { provider: 'github', owner: 'skyam25', repo: 'agent-brief' } as const;

// The review pane loads project HTML over its own scheme, so it needs standard URL rules and fetch.
protocol.registerSchemesAsPrivileged([{ scheme: REVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** Test runs stay off screen, out of the Dock and away from focus, unless COMPANION_TEST_VISIBLE=1. */
const offscreen = testMode && process.env.COMPANION_TEST_VISIBLE !== '1';
if (offscreen && process.platform === 'darwin') app.setActivationPolicy('accessory');

// Each test gets a fresh profile, so a GPU shader cache only costs disk.
if (testMode) app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Tests feed a WAV file to Chromium as the microphone, with no permission prompt.
if (testMode && process.env.COMPANION_TEST_AUDIO) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.COMPANION_TEST_AUDIO);
  // The sandboxed audio process cannot open the file, so audio runs in the main process for tests.
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
}

if (process.env.COMPANION_DATA_DIR) app.setPath('userData', process.env.COMPANION_DATA_DIR);
// Boards and settings from before the app was renamed Agent Brief.
else migrateData(join(app.getPath('appData'), 'Web Agent Companion'), app.getPath('userData'));
const dataDir = app.getPath('userData');
const socketPath = process.env[SOCKET_ENV] ?? defaultSocketPath(homedir());

const store = new BoardStore(dataDir);
const state = new StateFile(dataDir);
const history = new SendHistory(dataDir);
const drafts = new DraftStore(dataDir);
const templates = new TemplateStore(dataDir);
const initiatives = new InitiativeStore(dataDir, { liveSessions: () => sessions.sessions.map((s) => s.sessionId) });
let prompt: string | undefined;
let sessions: SessionsResponse = { sessions: [] };

const BACKGROUND: Record<Theme, string> = { light: '#ffffff', dark: '#121212' };
const theme = (): Theme => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

async function microphoneAccess(): Promise<MicrophoneAccess> {
  if (testMode) {
    const status = (process.env.COMPANION_TEST_MIC ?? 'granted') as MicrophoneAccess['status'];
    return { granted: status === 'granted', status };
  }
  if (process.platform !== 'darwin') return { granted: true, status: 'granted' };
  const status = systemPreferences.getMediaAccessStatus('microphone') as MicrophoneAccess['status'];
  if (status === 'granted' || status === 'denied' || status === 'restricted') return { granted: status === 'granted', status };
  const granted = await systemPreferences.askForMediaAccess('microphone');
  return { granted, status: granted ? 'granted' : 'denied' };
}

async function start(): Promise<void> {
  await app.whenReady();
  const ipc = mainIpc(ipcMain);
  if (offscreen) app.dock?.hide();
  app.setAboutPanelOptions({ applicationName: 'Agent Brief', applicationVersion: app.getVersion() });
  store.create(state.state.currentBoard);
  nativeTheme.themeSource = state.state.appearance;

  const panel = new Panel({
    preload: join(__dirname, '../preload/index.cjs'),
    url: process.env.COMPANION_DEV_URL,
    file: join(__dirname, '../renderer/index.html'),
    size: { width: state.state.width, height: state.state.height },
    onResize: (size) => state.update(size),
    offscreen,
    backgroundColor: BACKGROUND[theme()],
    // The page stays "visible" to itself because background throttling is off, so main says when it shows.
    onVisibility: (visible) => panel.win.webContents.send(CH.visibility, visible),
  });
  const send = (channel: string, ...args: unknown[]) => panel.win.webContents.send(channel, ...args);
  const bridge = new RendererBridge(() => panel.win.webContents);
  // Only the panel's own page load resets the bridge. A review's page loads in a frame, and the panel stays ready.
  panel.win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) bridge.reset();
  });

  nativeTheme.on('updated', () => {
    panel.win.setBackgroundColor(BACKGROUND[theme()]);
    send(CH.theme, theme());
  });

  // The renderer may use the microphone, and nothing else that asks.
  // Pages in the review pane get nothing.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] };
    if (details.requestingUrl?.startsWith(`${REVIEW_SCHEME}:`)) return callback(false);
    callback(permission === 'media' && (media.mediaTypes ?? []).every((t) => t === 'audio'));
  });

  // The review pane: project files over their own scheme, and a frame that stays on it.
  const reviewRoots = new ReviewRoots();
  protocol.handle(REVIEW_SCHEME, (request) => serveReview(reviewRoots, overlayFileFrom(__dirname), request));
  panel.win.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !e.url.startsWith(`${REVIEW_SCHEME}://`) && e.url !== 'about:blank') e.preventDefault();
  });

  const voiceDir = join(app.getPath('temp'), 'agent-brief-voice');
  const setPrompt = (text: string | undefined) => {
    prompt = text;
    send(CH.prompt, text);
  };

  /** Files and links tests asked to open, in place of opening them. */
  const openedOutputs: string[] = [];
  const opener: Opener = {
    async openPath(target) {
      if (testMode) return void openedOutputs.push(target);
      const failed = await shell.openPath(target);
      if (failed) throw new Error(failed);
    },
    async openExternal(url) {
      if (testMode) openedOutputs.push(url);
      else await shell.openExternal(url);
    },
  };

  const briefs = new Briefs({ state, store, drafts, sessions: () => server.sessions(), send, onPublish: () => files.sync() });
  const behaviors = new BehaviorStore(() => send(CH.behaviorChanged));
  const feedback = new FeedbackStore(() => send(CH.feedbackChanged));
  const captures = captureSession(session.fromPartition('feedback-capture'), (request) => serveReview(reviewRoots, overlayFileFrom(__dirname), request));
  const feedbackSnaps = new FeedbackSnaps({ store: feedback, urlFor: (cwd, path) => reviewRoots.urlFor(cwd, path), capture: offscreenCapture(BrowserWindow, captures) });
  const behaviorRoot = (sessionId: string) => {
    const cwd = briefs.cwdOf(sessionId);
    if (!cwd) throw new Error('Unknown session');
    return cwd;
  };
  const files = new SessionFiles({ briefs, drafts, send, opener, reviewUrlFor: (cwd, path) => reviewRoots.urlFor(cwd, path) });
  const terminals = new Terminals({ testMode, writeClipboard: (text) => clipboard.writeText(text) });
  // Each live session's mode. The mod sets it over PATCH /sessions/:id; the app only shows it.
  const modes = new SessionModes();
  /** What a test run's Copy put on the clipboard, in place of the clipboard. */
  let copiedRich: { html: string; text: string } | undefined;
  /** A board History restored. Switching to it is no session's choice, so it is not recorded. */
  let restoredBoard: string | undefined;

  const baseBackend = createBoardBackend({ store, state, panel, bridge, setPrompt, boards: () => briefs.boardsWithHolders() });
  const backend: BoardBackend = {
    ...baseBackend,
    tracking(sessionId) {
      const b = briefs.get(sessionId);
      return b ? { trackItems: !!b.trackItems } : undefined;
    },
    setTracking(sessionId, on) {
      // Turning tracking off never makes a brief, which would show as an empty tab.
      if (on || briefs.get(sessionId)) briefs.keepPlace(sessionId, { trackItems: on });
    },
    mode: (sessionId) => modes.get(sessionId),
    setMode: (sessionId, patch) => modes.set(sessionId, patch),
    // The brief reaches the panel before the target does, so the sidebar never falls back to Unfiled.
    claim(sessionId) {
      if (!briefs.get(sessionId)) briefs.remember(sessionId, {});
    },
    // A note from `agent-brief note`. The panel stays as it is and lists the note.
    addNote(req) {
      const draft = drafts.addNote(req);
      if (req.sessionId) briefs.remember(req.sessionId, {}, !briefs.get(req.sessionId));
      send(CH.draftsChanged);
      return { ok: true, draftId: draft.id };
    },
    async open(req) {
      // The user just typed /sketch, so the session's terminal is still in front.
      const live = briefs.live(req.sessionId);
      if (live) await terminals.capture(live);
      // The server checked the session is live and the path names a Markdown or HTML file.
      if (req.output && req.sessionId) {
        let opened: 'note' | 'review';
        try {
          opened = await files.openDocument(req.sessionId, req.output.path);
        } catch (err) {
          throw new BadRequest((err as Error).message);
        }
        if (req.prompt !== undefined) setPrompt(req.prompt);
        panel.show();
        return { board: state.state.currentBoard, targetSessionId: req.sessionId, opened };
      }
      if (req.mode === 'write') {
        if (req.prompt !== undefined) setPrompt(req.prompt);
        panel.show();
        briefs.openNote(req.sessionId, req.text);
        return {
          board: state.state.currentBoard,
          ...(req.sessionId ? { targetSessionId: req.sessionId } : {}),
          ...(req.text ? { noteText: true } : {}),
        };
      }
      if (!req.sessionId) return baseBackend.open(req);
      const res = await baseBackend.open({ ...req, board: req.board ?? briefs.boardFor(req.sessionId) });
      briefs.remember(req.sessionId, { board: res.board, last: 'board' });
      return res;
    },
  };

  // The socket server: sessions, deliveries and the board API for the CLI and the mod.
  // POST /open runs backend.open, which shows the panel and sets the prompt.
  const workspaces = new FeedbackWorkspaces({ feedback, store, boards: backend });
  const server: CompanionServer = createCompanionServer({ socketPath, backend, initiatives, behaviors, feedback, feedbackSnaps, workspaces });

  // Writes pending saves and closes the socket once before quitting.
  const quitter = new Quitter({
    flush: () => bridge.request('flush', {}, 2000),
    closeServer: () => server.close(),
    quit: () => app.quit(),
    exit: () => app.exit(0),
  });

  // Initiatives: a change from the socket, the panel or a brief edited by hand reaches the panel as a push.
  // Each brief's folder is watched, and reading a changed brief records the PM's revision.
  const briefWatch = new ItemsWatcher((id) => initiatives.refresh(id));
  initiatives.onChange(() => {
    send(CH.initiativesChanged, initiatives.list());
    briefWatch.sync(initiatives.files());
  });
  briefWatch.sync(initiatives.files());
  const initiativeDetail = (id: string): InitiativeDetail => ({ initiative: initiatives.get(id), history: initiatives.history(id) });
  // An initiative lists its live sessions, so the panel rereads when the live set changes.
  let liveKey = '';
  server.onSessionsChange((s) => {
    sessions = s;
    send(CH.sessions, s);
    rememberProjects(state, s.sessions.map((x) => x.cwd));
    briefs.refresh(s.sessions);
    const live = s.sessions.map((x) => x.sessionId);
    const key = [...live].sort().join('\n');
    if (key !== liveKey) {
      liveKey = key;
      send(CH.initiativesChanged, initiatives.list());
    }
    terminals.keepOnly(live);
    modes.keepOnly(live);
  });
  try {
    await server.listen();
    sessions = server.sessions();
  } catch (err) {
    console.error(`[companion] socket server did not start: ${(err as Error).message}`);
  }
  files.sync();

  const sender = new Sender({ state, history, drafts, server, briefs, terminals, voiceDir });
  const installs = createInstalls(testMode);

  // COMPANION_UPDATE_URL points a packaged build at a local feed, also in test runs.
  // A `pnpm dist` build has no app-update.yml, so it reads the GitHub releases directly.
  const updateUrl = process.env.COMPANION_UPDATE_URL;
  if (app.isPackaged && updateUrl) autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
  else if (app.isPackaged && !existsSync(join(process.resourcesPath, 'app-update.yml'))) autoUpdater.setFeedURL(RELEASES);
  const updater = new Updater({
    version: app.getVersion(),
    source: app.isPackaged && (!testMode || updateUrl) ? autoUpdater : undefined,
    onStatus: (status) => {
      send(CH.update, status);
      controls.buildMenus();
    },
    beforeInstall: async () => {
      await quitter.prepare();
      panel.prepareQuit();
    },
    confirmRestart: async (version) => {
      app.focus({ steal: true });
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `Agent Brief ${version} is ready`,
        detail:
          'Restart now to update. Agent Brief saves your boards and notes first.\n\nChoose Later to keep working. The update installs the next time Agent Brief quits, or when you pick Restart to Update.',
      });
      return response === 0;
    },
  });

  const controls = createControls({ testMode, state, panel, server, installs, updater, send, setPrompt });
  updater.schedule();
  if (app.isPackaged && !testMode && !isTranslocated(process.resourcesPath)) {
    setTimeout(() => void installs.repair(), 15_000).unref();
  }

  // Panel and settings.
  ipc.handle(
    'init',
    (): InitInfo => ({
      currentBoard: state.state.currentBoard,
      home: homedir(),
      prompt,
      sessions,
      testMode,
      theme: theme(),
      settings: controls.settings(),
      panelVisible: panel.isVisible(),
      mode: state.state.mode,
    }),
  );
  ipc.on('ready', () => bridge.ready());
  ipcMain.on(CH.reply, (_e, reply: BoardReply) => bridge.handleReply(reply));
  ipc.on('hidePanel', () => panel.hide());
  ipc.on('setMode', (mode: Mode) => {
    if (mode !== 'sketch' && mode !== 'write' && mode !== 'review' && mode !== 'initiative') return;
    state.update({ mode });
    controls.buildMenus();
  });
  ipc.handle('getSettings', () => controls.settings());
  ipc.handle('setSettings', (patch: Partial<Settings>) => controls.applySettings(patch ?? {}));
  ipc.handle('requestMicrophone', () => microphoneAccess());
  ipc.handle('getUpdate', () => updater.current());
  ipc.handle('updateNow', () => updater.update());
  ipc.handle('installUpdate', () => updater.install());
  ipc.handle('capturePanel', (rect: unknown) => panel.capture(rect));
  ipc.handle('transcribeClip', (clip: { data?: unknown; mimeType?: unknown }) => transcribeClip(clip, voiceDir));
  ipc.handle('openLink', async (url: unknown) => opener.openExternal(webUrl(String(url), 'Not a link').href));

  // Boards.
  ipc.handle('listBoards', () => briefs.boardsWithHolders());
  ipc.handle('loadBoard', (name: string) => store.load(name));
  ipc.handle('saveBoard', (name: string, json: string) => {
    store.saveScene(name, json);
    briefs.touched({ board: name });
  });
  ipc.handle('saveNotes', (name: string, text: string) => {
    store.saveNotes(name, text);
    briefs.touched({ board: name });
  });
  ipc.handle('createBoard', (name: string) => store.create(name));
  ipc.handle('renameBoard', (from: string, to: string) => {
    const name = store.rename(from, to);
    if (state.state.currentBoard === from) state.update({ currentBoard: name });
    if (state.state.unfiledBoard === from) state.update({ unfiledBoard: name });
    drafts.renameBoard(from, name);
    briefs.renameBoard(from, name);
    return name;
  });
  ipc.handle('deleteBoard', async (raw: string) => {
    const name = cleanName(raw);
    if (name === state.state.currentBoard) throw new Error('Open another board before deleting this one');
    const paths = store.files(name);
    // Test runs delete outright, so they never fill the user's Trash.
    if (testMode) for (const f of paths) rmSync(f, { force: true });
    else for (const f of paths) await shell.trashItem(f);
    drafts.forgetBoard(name);
    briefs.forgetBoard(name);
    if (state.state.unfiledBoard === name) state.update({ unfiledBoard: undefined });
  });
  // The renderer passes only the session's own boards or an unfiled board the user chose to attach.
  ipc.handle('setCurrent', (raw: string) => {
    const board = store.create(raw);
    const target = server.sessions().targetSessionId;
    state.update({ currentBoard: board, ...(target ? {} : { unfiledBoard: board }) });
    if (board === restoredBoard) restoredBoard = undefined;
    else if (target) briefs.remember(target, { board, last: 'board' }, false);
  });
  ipc.handle('detachBoard', (sessionId: string, name: string) => briefs.detach(sessionId, name));
  ipc.handle('moveBoards', (raw: string[], sessionId: string) => {
    const names = raw.map(cleanName);
    briefs.move(names, sessionId);
    if (state.state.unfiledBoard && names.includes(state.state.unfiledBoard)) state.update({ unfiledBoard: undefined });
  });

  // Drafts, templates and history.
  ipc.handle('listDrafts', () => drafts.list());
  ipc.handle('saveDraft', (raw: unknown) => {
    const draft = drafts.save(raw);
    briefs.touched({ draftId: draft.id });
  });
  ipc.handle('deleteDraft', (id: string) => {
    drafts.remove(id);
    briefs.touched({ draftId: id });
  });
  ipc.handle('copyRich', async (clip: { html?: unknown; text?: unknown }) => {
    const rich = { html: String(clip?.html ?? ''), text: String(clip?.text ?? '') };
    if (testMode) copiedRich = rich;
    else await clipboard.write([new ClipboardItem({ 'text/html': rich.html, 'text/plain': rich.text })]);
  });
  ipc.handle('listTemplates', () => templates.list());
  ipc.handle('saveTemplate', (template: unknown) => templates.save(template));
  ipc.handle('deleteTemplate', (id: string) => templates.remove(id));
  ipc.handle('listHistory', () => history.list().map((e) => ({ ...e, png: history.png(e.id) })));
  ipc.handle('restoreHistory', (id: string) => {
    const entry = history.get(id);
    const scene = history.scene(id);
    if (!entry || (scene === undefined && !entry.text)) throw new Error('that send is no longer in the history');
    let board: string | undefined;
    if (entry.board && scene !== undefined) {
      board = store.create(restoredBoardName(entry.board, entry.sentAt, (n) => store.exists(n)));
      restoredBoard = board;
      store.saveScene(board, scene);
      if (entry.notes) store.saveNotes(board, entry.notes);
    }
    if (!entry.text) return { board };
    const now = Date.now();
    const draft = drafts.save({ id: newDraftId(now), body: entry.text, status: 'note', board, rank: 0, createdAt: now, updatedAt: now });
    return { board, draftId: draft.id };
  });

  // Sessions and their tabs.
  ipc.handle('setTarget', (sessionId: string | undefined) => {
    try {
      server.setTarget(sessionId);
    } catch (err) {
      console.warn(`[companion] ${(err as Error).message}`);
    }
  });
  ipc.handle('listBriefs', () => briefs.entries());
  ipc.handle('switchBrief', async (sessionId: string): Promise<SwitchResult> => {
    const b = briefs.get(sessionId);
    if (!b) throw new Error('that session has no brief');
    // An ended session can no longer take a Send, so its brief opens with no target.
    server.setTarget(briefs.live(sessionId) ? sessionId : undefined);
    setPrompt(undefined);
    const draft = b.draftId && drafts.get(b.draftId) ? b.draftId : undefined;
    const board = b.board && store.exists(b.board) ? b.board : undefined;
    if (draft && (b.last === 'draft' || !board)) {
      briefs.publish();
      return { draftId: draft };
    }
    const shown = board ?? store.create(briefs.boardFor(sessionId));
    await bridge.request('show', { board: shown, fromSwitch: true });
    briefs.publish();
    return { board: shown };
  });
  ipc.handle('openUnfiled', () => {
    server.setTarget(undefined);
    const choice = unfiledBoardChoice({ remembered: state.state.unfiledBoard, boards: briefs.boardsWithHolders() });
    const board = choice.isNew ? store.create(choice.board) : choice.board;
    state.update({ currentBoard: board, unfiledBoard: board });
    return { board };
  });
  ipc.handle('forgetBrief', (sessionId: string) => briefs.forget(sessionId));
  ipc.handle('focusSession', async (id: string) => {
    const live = briefs.live(id);
    if (live) await terminals.focus(live);
  });
  ipc.handle('resumeSession', async (sessionId: string, via: Launcher): Promise<SendResult> => {
    if (briefs.live(sessionId)) return { ok: false, message: 'That session is still running' };
    const cwd = briefs.get(sessionId)?.cwd;
    if (!cwd) return { ok: false, message: 'Agent Brief does not know which folder that session ran in' };
    return terminals.resume(sessionId, cwd, via);
  });

  // Items and outputs.
  ipc.handle('setTracking', (sessionId: string, on: boolean) => {
    if (!briefs.live(sessionId) && !briefs.get(sessionId)) throw new Error(`Agent Brief does not know session ${sessionId}`);
    briefs.keepPlace(sessionId, { trackItems: !!on });
    server.refreshSessions();
  });
  ipc.handle('readItems', (sessionId: string) => files.items(sessionId));
  ipc.handle('saveDecisions', (sessionId: string, decisions: unknown) => files.saveDecisions(sessionId, decisions));
  ipc.handle('openItemOutput', (sessionId: string, path: unknown) => files.openElsewhere(sessionId, path));
  ipc.handle('readOutputs', (sessionId: string) => files.outputs(sessionId));
  ipc.handle('openOutput', (sessionId: string, ref: unknown) => files.openOutput(sessionId, ref));
  ipc.handle('dismissOutput', (sessionId: string, ref: unknown) => files.dismissOutput(sessionId, ref));
  ipc.handle('openOutputElsewhere', (sessionId: string, ref: unknown) => files.openElsewhere(sessionId, ref));
  ipc.handle('readBehavior', (sessionId: string, path: unknown) => behaviors.read(behaviorRoot(sessionId), path));
  ipc.handle('decideBehavior', (sessionId: string, path: unknown, decision: unknown) => behaviors.decide(behaviorRoot(sessionId), path, decision));
  ipc.handle('readFeedback', (sessionId: string, path: unknown) => feedback.read(behaviorRoot(sessionId), path, { orphan: true }));
  ipc.handle('updateFeedback', (sessionId: string, path: unknown, update: unknown) => feedback.update(behaviorRoot(sessionId), path, update, 'You'));
  ipc.handle('listFeedback', (sessionId: string) => feedback.project(behaviorRoot(sessionId)));
  ipc.handle('openFeedbackWorkspace', (sessionId: string, path: unknown, n: unknown, snapshot?: unknown) => workspaces.open(behaviorRoot(sessionId), path, n, snapshot));
  ipc.handle('saveFeedbackWorkspace', (sessionId: string, path: unknown, n: unknown) => workspaces.save(behaviorRoot(sessionId), path, n, 'You'));
  ipc.handle('readFeedbackPicture', (sessionId: string, output: unknown, picture: unknown) => feedbackSnaps.picture(behaviorRoot(sessionId), output, picture));
  ipc.handle('reviewUrl', (sessionId: string, path: unknown) => files.reviewUrl(sessionId, path));
  ipc.handle('reviewEdit', (sessionId: string, path: unknown, version: unknown, edit: unknown) => files.reviewEdit(sessionId, path, version, edit));
  ipc.handle('reviewUndo', (sessionId: string, path: unknown) => files.reviewUndo(sessionId, path));
  ipc.handle('reviewRedo', (sessionId: string, path: unknown) => files.reviewRedo(sessionId, path));

  // Initiatives. The panel's changes are the PM's revisions.
  ipc.handle('listInitiatives', () => initiatives.list());
  ipc.handle('getInitiative', (id: string) => initiativeDetail(String(id)));
  ipc.handle('createInitiative', (raw: unknown) => {
    const created = initiatives.create({ ...parseInitiativeCreate(raw), updatedBy: 'PM' });
    return initiativeDetail(created.id);
  });
  ipc.handle('updateInitiative', (id: string, raw: unknown): InitiativeSaveResult => {
    const patch = parseInitiativeUpdate({ ...(raw as object), updatedBy: 'PM' });
    try {
      initiatives.update(String(id), patch);
      return { ok: true, detail: initiativeDetail(String(id)) };
    } catch (err) {
      if ((err as { code?: string }).code !== 'conflict') throw err;
      return { ok: false, message: (err as Error).message, detail: initiativeDetail(String(id)) };
    }
  });
  ipc.handle('revealPath', (raw: unknown) => {
    const target = expandHome(String(raw));
    if (testMode) openedOutputs.push(`reveal:${target}`);
    else shell.showItemInFolder(target);
  });

  // Send.
  ipc.handle('send', (payload: Outgoing) => sender.send(payload));
  ipc.handle('sendNew', (payload: Outgoing, target: { cwd: string; via: Launcher }) => sender.sendNew(payload, target));
  ipc.handle('copyPrompt', (payload: Outgoing, cwd: string) => sender.copyPrompt(payload, String(cwd)));
  ipc.handle('sessionPlaces', () => terminals.places(server.sessions().sessions));
  ipc.handle(
    'launchOptions',
    (): LaunchOptions => ({ launchers: terminals.launchers(), recentProjects: state.state.recentProjects ?? [] }),
  );
  ipc.handle('chooseFolder', async () => {
    if (testMode) return process.env.COMPANION_TEST_FOLDER;
    const picked = await dialog.showOpenDialog(panel.win, {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use Folder',
    });
    return picked.canceled ? undefined : picked.filePaths[0];
  });

  app.on('before-quit', (e) => quitter.beforeQuit(e));
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    files.close();
    briefWatch.close();
  });
  app.on('activate', controls.openStandalone);
  app.on('second-instance', controls.openStandalone);

  if (testMode) {
    Object.assign(globalThis, {
      __companion: {
        backend,
        panel,
        store,
        state,
        hotkey: controls.hotkey,
        newNote: controls.newNote,
        drafts,
        initiatives,
        registrar: controls.registrar,
        toggle: controls.togglePanel,
        buildDelivery: async () => (await sender.composeSketch(await bridge.request('payload', {}))).input,
        applySettings: controls.applySettings,
        installCli: (home: string) => installs.installCli({ confirm: false, home }),
        installPlugin: () => installs.installPlugin({ confirm: false }),
        trayMenu: () => trayMenuTemplate(controls.actions()).map((i) => i.label ?? i.type),
        history,
        launches: terminals.launches,
        clipboard: () => terminals.copied,
        richClipboard: () => copiedRich,
        openedOutputs,
      },
    });
  }
}

app.on('window-all-closed', () => {
  // The panel hides instead of closing, so this only runs on quit.
});

if (app.requestSingleInstanceLock()) {
  void start();
} else {
  app.exit(0);
}
