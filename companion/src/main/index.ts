import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
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
import { BadRequest } from '../server/validate';
import {
  CH,
  type BoardReply,
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
import { createInstalls } from './installs';
import { trayMenuTemplate } from './menus';
import { Panel } from './panel';
import { overlayFileFrom, REVIEW_SCHEME, ReviewRoots, serveReview } from './review-protocol';
import { rememberProjects, Sender } from './sender';
import { unfiledBoardChoice } from './session-briefs';
import { SessionFiles, webUrl, type Opener } from './session-files';
import { SessionModes } from './session-modes';
import { TemplateStore } from './templates';
import { Terminals } from './terminals';
import { Updater } from './updater';
import { BoardStore, cleanName, migrateData, StateFile } from './store';
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
  const server: CompanionServer = createCompanionServer({ socketPath, backend });
  server.onSessionsChange((s) => {
    sessions = s;
    send(CH.sessions, s);
    rememberProjects(state, s.sessions.map((x) => x.cwd));
    briefs.refresh(s.sessions);
    const live = s.sessions.map((x) => x.sessionId);
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
      await flushAll();
      panel.prepareQuit();
    },
  });

  const controls = createControls({ testMode, state, panel, server, installs, updater, send, setPrompt });
  updater.schedule();
  if (app.isPackaged && !testMode && !isTranslocated(process.resourcesPath)) {
    setTimeout(() => void installs.repair(), 15_000).unref();
  }

  // Panel and settings.
  ipcMain.handle(
    CH.init,
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
  ipcMain.on(CH.ready, () => bridge.ready());
  ipcMain.on(CH.reply, (_e, reply: BoardReply) => bridge.handleReply(reply));
  ipcMain.on(CH.hide, () => panel.hide());
  ipcMain.on(CH.setMode, (_e, mode: Mode) => {
    if (mode !== 'sketch' && mode !== 'write' && mode !== 'review') return;
    state.update({ mode });
    controls.buildMenus();
  });
  ipcMain.handle(CH.getSettings, () => controls.settings());
  ipcMain.handle(CH.setSettings, (_e, patch: Partial<Settings>) => controls.applySettings(patch ?? {}));
  ipcMain.handle(CH.mic, () => microphoneAccess());
  ipcMain.handle(CH.updateGet, () => updater.current());
  ipcMain.handle(CH.updateCheck, () => updater.check());
  ipcMain.handle(CH.updateInstall, () => updater.install());
  ipcMain.handle(CH.capturePanel, (_e, rect: unknown) => panel.capture(rect));
  ipcMain.handle(CH.transcribeClip, (_e, clip: { data?: unknown; mimeType?: unknown }) => transcribeClip(clip, voiceDir));
  ipcMain.handle(CH.openLink, async (_e, url: unknown) => opener.openExternal(webUrl(String(url), 'Not a link').href));

  // Boards.
  ipcMain.handle(CH.listBoards, () => briefs.boardsWithHolders());
  ipcMain.handle(CH.loadBoard, (_e, name: string) => store.load(name));
  ipcMain.handle(CH.saveBoard, (_e, name: string, json: string) => {
    store.saveScene(name, json);
    briefs.touched({ board: name });
  });
  ipcMain.handle(CH.saveNotes, (_e, name: string, text: string) => {
    store.saveNotes(name, text);
    briefs.touched({ board: name });
  });
  ipcMain.handle(CH.createBoard, (_e, name: string) => store.create(name));
  ipcMain.handle(CH.renameBoard, (_e, from: string, to: string) => {
    const name = store.rename(from, to);
    if (state.state.currentBoard === from) state.update({ currentBoard: name });
    if (state.state.unfiledBoard === from) state.update({ unfiledBoard: name });
    drafts.renameBoard(from, name);
    briefs.renameBoard(from, name);
    return name;
  });
  ipcMain.handle(CH.deleteBoard, async (_e, raw: string) => {
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
  ipcMain.handle(CH.setCurrent, (_e, raw: string) => {
    const board = store.create(raw);
    const target = server.sessions().targetSessionId;
    state.update({ currentBoard: board, ...(target ? {} : { unfiledBoard: board }) });
    if (board === restoredBoard) restoredBoard = undefined;
    else if (target) briefs.remember(target, { board, last: 'board' }, false);
  });
  ipcMain.handle(CH.detachBoard, (_e, sessionId: string, name: string) => briefs.detach(sessionId, name));

  // Drafts, templates and history.
  ipcMain.handle(CH.listDrafts, () => drafts.list());
  ipcMain.handle(CH.saveDraft, (_e, raw: unknown) => {
    const draft = drafts.save(raw);
    briefs.touched({ draftId: draft.id });
  });
  ipcMain.handle(CH.deleteDraft, (_e, id: string) => {
    drafts.remove(id);
    briefs.touched({ draftId: id });
  });
  ipcMain.handle(CH.copyRich, async (_e, clip: { html?: unknown; text?: unknown }) => {
    const rich = { html: String(clip?.html ?? ''), text: String(clip?.text ?? '') };
    if (testMode) copiedRich = rich;
    else await clipboard.write([new ClipboardItem({ 'text/html': rich.html, 'text/plain': rich.text })]);
  });
  ipcMain.handle(CH.listTemplates, () => templates.list());
  ipcMain.handle(CH.saveTemplate, (_e, template: unknown) => templates.save(template));
  ipcMain.handle(CH.deleteTemplate, (_e, id: string) => templates.remove(id));
  ipcMain.handle(CH.historyList, () => history.list().map((e) => ({ ...e, png: history.png(e.id) })));
  ipcMain.handle(CH.historyRestore, (_e, id: string) => {
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
  ipcMain.handle(CH.setTarget, (_e, sessionId: string | undefined) => {
    try {
      server.setTarget(sessionId);
    } catch (err) {
      console.warn(`[companion] ${(err as Error).message}`);
    }
  });
  ipcMain.handle(CH.listBriefs, () => briefs.entries());
  ipcMain.handle(CH.switchBrief, async (_e, sessionId: string): Promise<SwitchResult> => {
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
  ipcMain.handle(CH.openUnfiled, () => {
    server.setTarget(undefined);
    const choice = unfiledBoardChoice({ remembered: state.state.unfiledBoard, boards: briefs.boardsWithHolders() });
    const board = choice.isNew ? store.create(choice.board) : choice.board;
    state.update({ currentBoard: board, unfiledBoard: board });
    return { board };
  });
  ipcMain.handle(CH.forgetBrief, (_e, sessionId: string) => briefs.forget(sessionId));
  ipcMain.handle(CH.focusSession, async (_e, id: string) => {
    const live = briefs.live(id);
    if (live) await terminals.focus(live);
  });
  ipcMain.handle(CH.resumeSession, async (_e, sessionId: string, via: Launcher): Promise<SendResult> => {
    if (briefs.live(sessionId)) return { ok: false, message: 'That session is still running' };
    const cwd = briefs.get(sessionId)?.cwd;
    if (!cwd) return { ok: false, message: 'Agent Brief does not know which folder that session ran in' };
    return terminals.resume(sessionId, cwd, via);
  });

  // Items and outputs.
  ipcMain.handle(CH.setTracking, (_e, sessionId: string, on: boolean) => {
    if (!briefs.live(sessionId) && !briefs.get(sessionId)) throw new Error(`Agent Brief does not know session ${sessionId}`);
    briefs.keepPlace(sessionId, { trackItems: !!on });
    server.refreshSessions();
  });
  ipcMain.handle(CH.readItems, (_e, sessionId: string) => files.items(sessionId));
  ipcMain.handle(CH.saveDecisions, (_e, sessionId: string, decisions: unknown) => files.saveDecisions(sessionId, decisions));
  ipcMain.handle(CH.openItemOutput, (_e, sessionId: string, path: unknown) => files.openElsewhere(sessionId, path));
  ipcMain.handle(CH.readOutputs, (_e, sessionId: string) => files.outputs(sessionId));
  ipcMain.handle(CH.openOutput, (_e, sessionId: string, ref: unknown) => files.openOutput(sessionId, ref));
  ipcMain.handle(CH.dismissOutput, (_e, sessionId: string, ref: unknown) => files.dismissOutput(sessionId, ref));
  ipcMain.handle(CH.openOutputElsewhere, (_e, sessionId: string, ref: unknown) => files.openElsewhere(sessionId, ref));
  ipcMain.handle(CH.reviewUrl, (_e, sessionId: string, path: unknown) => files.reviewUrl(sessionId, path));
  ipcMain.handle(CH.reviewEdit, (_e, sessionId: string, path: unknown, version: unknown, edit: unknown) => files.reviewEdit(sessionId, path, version, edit));
  ipcMain.handle(CH.reviewUndo, (_e, sessionId: string, path: unknown) => files.reviewUndo(sessionId, path));
  ipcMain.handle(CH.reviewRedo, (_e, sessionId: string, path: unknown) => files.reviewRedo(sessionId, path));

  // Send.
  ipcMain.handle(CH.send, (_e, payload: Outgoing) => sender.send(payload));
  ipcMain.handle(CH.sendNew, (_e, payload: Outgoing, target: { cwd: string; via: Launcher }) => sender.sendNew(payload, target));
  ipcMain.handle(CH.copyPrompt, (_e, payload: Outgoing, cwd: string) => sender.copyPrompt(payload, String(cwd)));
  ipcMain.handle(CH.sessionPlaces, () => terminals.places(server.sessions().sessions));
  ipcMain.handle(
    CH.launchOptions,
    (): LaunchOptions => ({ launchers: terminals.launchers(), recentProjects: state.state.recentProjects ?? [] }),
  );
  ipcMain.handle(CH.chooseFolder, async () => {
    if (testMode) return process.env.COMPANION_TEST_FOLDER;
    const picked = await dialog.showOpenDialog(panel.win, {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use Folder',
    });
    return picked.canceled ? undefined : picked.filePaths[0];
  });

  // Write pending saves and close the socket once before quitting.
  let flushed = false;
  async function flushAll(): Promise<void> {
    if (flushed) return;
    await bridge
      .request('flush', {}, 2000)
      .catch(() => undefined)
      .then(() => server.close())
      .catch(() => undefined);
    flushed = true;
  }
  app.on('before-quit', (e) => {
    if (flushed) return;
    e.preventDefault();
    void flushAll().finally(() => app.quit());
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    files.close();
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
