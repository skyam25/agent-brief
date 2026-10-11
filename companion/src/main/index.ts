import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  session,
  systemPreferences,
  Tray,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { defaultSocketPath, SOCKET_ENV, type SessionsResponse } from '../protocol';
import type { BoardBackend, DeliveryInput } from '../server/contract';
import { buildDraft, freeId, writeBundle } from '../server/bundle';
import { createCompanionServer, type CompanionServer } from '../server/index';
import {
  CH,
  isTextPayload,
  type BoardReply,
  type InitInfo,
  type Launcher,
  type LaunchOptions,
  type MicrophoneAccess,
  type Mode,
  type Outgoing,
  type SendPayload,
  type SessionBriefEntry,
  type Settings,
  type SettingsResult,
  type Theme,
} from '../shared/ipc';
import { createBoardBackend } from './backend';
import { newDraftId } from '../shared/drafts';
import { folderName } from '../shared/sessions';
import { remember, renameBoard as renameInBriefs, sketchBoard, type SessionBrief } from './session-briefs';
import { DraftStore } from './drafts';
import { TemplateStore } from './templates';
import { RendererBridge } from './bridge';
import { cliLinkPath, installCli, type InstallResult } from './cli-install';
import { FakeRegistrar, Hotkey, type Registrar } from './hotkey';
import { appMenuTemplate, trayMenuTemplate, type MenuActions } from './menus';
import { composeDelivery, findTool } from '../voice/compose';
import { restoredBoardName, SendHistory } from './history';
import {
  exec,
  focusSession,
  frontGhosttyTerminal,
  isGhostty,
  startCommand,
  startSession,
  type Exec,
} from './launch';
import { Panel } from './panel';
import { Updater } from './updater';
import { BoardStore, migrateData, StateFile } from './store';

const testMode = process.env.COMPANION_TEST === '1';

/** Test runs stay off screen, out of the Dock and away from focus, unless COMPANION_TEST_VISIBLE=1. */
const offscreen = testMode && process.env.COMPANION_TEST_VISIBLE !== '1';
if (offscreen && process.platform === 'darwin') app.setActivationPolicy('accessory');

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
let lastDelivery: DeliveryInput | undefined;

const BACKGROUND: Record<Theme, string> = { light: '#ffffff', dark: '#121212' };
const theme = (): Theme => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

const settingsOf = (): Settings => ({
  hotkey: state.state.hotkey,
  deliveryMode: state.state.deliveryMode,
  openAtLogin: state.state.openAtLogin,
  captureHotkey: state.state.captureHotkey,
});

/**
 * Turns what the renderer sends into a delivery: transcribes the voice clips
 * with ffmpeg and yap and builds timeline.md. Problems with voice come back as
 * warnings, so the sketch still goes out.
 */
async function composeFrom(p: SendPayload): Promise<{ input: DeliveryInput; warnings: string[] }> {
  const warnings: string[] = [];
  const segments = p.segments.map((s) => ({ ...s, data: Buffer.from(s.data) }));
  const ffmpegPath = findTool('ffmpeg');
  const yapPath = findTool('yap');
  if (segments.length > 0 && (!ffmpegPath || !yapPath)) {
    warnings.push(`voice not transcribed: ${!ffmpegPath ? 'ffmpeg' : 'yap'} not found`);
  }
  const input = await composeDelivery({
    boardName: p.boardName,
    png: Buffer.from(p.png),
    scene: p.scene,
    notes: p.notes || undefined,
    strokes: p.strokes,
    segments,
    bounds: p.bounds,
    mode: state.state.deliveryMode,
    text: p.text || undefined,
    transcribe: {
      ffmpegPath: ffmpegPath ?? 'ffmpeg',
      yapPath: yapPath ?? 'yap',
      tmpDir: join(app.getPath('temp'), 'agent-brief-voice'),
      onError: (segment, message) => {
        if (ffmpegPath && yapPath) warnings.push(`${segment}: ${message}`);
      },
    },
  });
  return { input, warnings };
}

/** A delivery from either mode. A written draft alone needs no voice work. */
async function composeOutgoing(p: Outgoing): Promise<{ input: DeliveryInput; warnings: string[] }> {
  if (!isTextPayload(p)) return composeFrom(p);
  return { input: { boardName: '', text: p.text, mode: state.state.deliveryMode }, warnings: [] };
}

/** History fields that depend on what went out. */
const sent = (input: DeliveryInput) => ({
  ...(input.boardName ? { board: input.boardName } : {}),
  ...(input.text ? { text: input.text } : {}),
  ...(input.notes ? { notes: input.notes } : {}),
});

const LAUNCHER_NAMES: Record<Launcher, string> = { ghostty: 'Ghostty', terminal: 'Terminal', herdr: 'herdr', copy: 'the clipboard' };
const RECENT_PROJECTS = 8;

/** Tests record launches instead of opening terminals, and keep the clipboard untouched. */
const launches: { file: string; args: string[] }[] = [];
let testClipboard: string | undefined;
const run: Exec = testMode
  ? async (file, args) => {
      launches.push({ file, args });
      return args[0] === 'tab' ? JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }) : '';
    }
  : exec;

const herdrPath = () => findTool('herdr', [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']);

function launchers(): Launcher[] {
  if (testMode) return ['ghostty', 'terminal', 'herdr', 'copy'];
  const ghostty = ['/Applications', join(homedir(), 'Applications')].some((d) => existsSync(join(d, 'Ghostty.app')));
  return [...(ghostty ? (['ghostty'] as const) : []), 'terminal', ...(herdrPath() ? (['herdr'] as const) : []), 'copy'];
}

function rememberProjects(cwds: string[]): void {
  const prev = state.state.recentProjects ?? [];
  const next = [...new Set([...cwds, ...prev])].slice(0, RECENT_PROJECTS);
  if (next.join('\n') !== prev.join('\n')) state.update({ recentProjects: next });
}

/** The CLI script: inside the app bundle when packaged, else the repo's build. */
function cliSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin/agent-brief') : join(app.getAppPath(), 'bin/agent-brief');
}

/** PATH as the user's login shell sets it. GUI apps start with a much shorter one. */
function loginShellPath(): Promise<string> {
  const fallback = process.env.PATH ?? '';
  if (testMode) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { timeout: 3000 }, (err, stdout) =>
      resolve(err || !stdout ? fallback : stdout.trim().split('\n').pop()!),
    );
  });
}

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
  panel.win.webContents.on('did-start-loading', () => bridge.reset());

  nativeTheme.on('updated', () => {
    panel.win.setBackgroundColor(BACKGROUND[theme()]);
    send(CH.theme, theme());
  });

  // The renderer may use the microphone, and nothing else that asks.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] };
    callback(permission === 'media' && (media.mediaTypes ?? []).every((t) => t === 'audio'));
  });

  const setPrompt = (text: string | undefined) => {
    prompt = text;
    send(CH.prompt, text);
  };
  // Ghostty terminal ids captured when a session runs /sketch, for jumping back to it.
  const ghosttyTerminals = new Map<string, string>();
  const baseBackend = createBoardBackend({ store, state, panel, bridge, setPrompt });

  // Each Claude Code session's latest board and note, so /sketch, /write and the tabs reopen them.
  const briefs = () => state.state.sessionBriefs ?? {};
  const liveSession = (id: string) => server.sessions().sessions.find((x) => x.sessionId === id);
  const briefEntries = (): SessionBriefEntry[] => {
    const { targetSessionId } = server.sessions();
    return Object.entries(briefs())
      .sort(([, a], [, b]) => b.at - a.at)
      .map(([sessionId, b]) => {
        const live = liveSession(sessionId);
        const draft = b.draftId ? drafts.get(b.draftId) : undefined;
        const board = b.board && store.exists(b.board) ? b.board : undefined;
        return {
          sessionId,
          title: live ? live.title || folderName(live.cwd) : (b.title ?? 'Ended session'),
          ...((live?.cwd ?? b.cwd) ? { cwd: live?.cwd ?? b.cwd } : {}),
          ...(board ? { board } : {}),
          ...(draft ? { draftId: draft.id } : {}),
          ...(b.last ? { last: b.last } : {}),
          at: b.at,
          isLive: !!live,
          isTarget: targetSessionId === sessionId,
          hasContent: (!!board && !store.isEmpty(board)) || !!draft?.body.trim(),
        };
      });
  };
  const publishBriefs = () => send(CH.briefs, briefEntries());
  /**
   * Records what a session opened. Claude Code opening it moves its tab to the front;
   * a switch in the panel (`touch: false`) keeps the tab where it is.
   */
  const rememberBrief = (sessionId: string, patch: Partial<Omit<SessionBrief, 'at'>>, touch = true) => {
    const live = liveSession(sessionId);
    const known = live ? { title: live.title || folderName(live.cwd), cwd: live.cwd } : {};
    const at = touch ? Date.now() : (briefs()[sessionId]?.at ?? Date.now());
    state.update({ sessionBriefs: remember(briefs(), sessionId, { ...patch, ...known }, at) });
    publishBriefs();
  };
  /** Republishes when a board or note a tab shows changes, for its unsent-content mark. */
  const briefTouched = (what: { board?: string; draftId?: string }) => {
    if (Object.values(briefs()).some((b) => (what.board && b.board === what.board) || (what.draftId && b.draftId === what.draftId))) publishBriefs();
  };
  /** A board History restored. Switching to it is no session's choice, so it is not recorded. */
  let restoredBoard: string | undefined;
  /** The board /sketch opens for a session that names none. */
  const sessionBoard = (sessionId: string) => {
    const live = liveSession(sessionId);
    return sketchBoard({
      sessionId,
      briefs: briefs(),
      current: state.state.currentBoard,
      label: live ? live.title || folderName(live.cwd) : (briefs()[sessionId]?.title ?? 'session'),
      exists: (n) => store.exists(n),
      isEmpty: (n) => store.isEmpty(n),
    }).board;
  };
  /** Opens a note in Write mode: the session's last one when it still exists and no text came, else a new one. */
  const openNote = (sessionId: string | undefined, text: string | undefined) => {
    const kept = sessionId && !text ? briefs()[sessionId]?.draftId : undefined;
    panel.show();
    if (kept && drafts.get(kept)) {
      send(CH.openDraft, kept);
      if (sessionId) rememberBrief(sessionId, { draftId: kept, last: 'draft' });
      return;
    }
    const id = newDraftId();
    send(CH.newNote, { text, id });
    if (sessionId) rememberBrief(sessionId, { draftId: id, last: 'draft' });
  };

  const backend: BoardBackend = {
    ...baseBackend,
    async open(req) {
      // The user just typed /sketch, so the session's terminal is still in front.
      const s = server.sessions().sessions.find((x) => x.sessionId === req.sessionId);
      if (s && isGhostty(s.host)) {
        const id = await frontGhosttyTerminal(run, s.cwd);
        if (id) ghosttyTerminals.set(s.sessionId, id);
      }
      if (req.mode === 'write') {
        if (req.prompt !== undefined) setPrompt(req.prompt);
        openNote(req.sessionId, req.text);
        return {
          board: state.state.currentBoard,
          ...(req.sessionId ? { targetSessionId: req.sessionId } : {}),
          ...(req.text ? { noteText: true } : {}),
        };
      }
      if (!req.sessionId) return baseBackend.open(req);
      const res = await baseBackend.open({ ...req, board: req.board ?? sessionBoard(req.sessionId) });
      rememberBrief(req.sessionId, { board: res.board, last: 'board' });
      return res;
    },
  };

  /** Shows the panel from the hotkey, menus or Dock. Opening it this way picks no session. */
  const openStandalone = () => {
    if (!panel.isVisible()) {
      server.setTarget(undefined);
      setPrompt(undefined);
    }
    panel.show();
  };

  // The socket server: sessions, deliveries and the board API for the CLI and the mod.
  // POST /open runs backend.open, which shows the panel and sets the prompt.
  const server: CompanionServer = createCompanionServer({ socketPath, backend });
  server.onSessionsChange((s) => {
    sessions = s;
    send(CH.sessions, s);
    rememberProjects(s.sessions.map((x) => x.cwd));
    publishBriefs();
    for (const id of ghosttyTerminals.keys()) if (!s.sessions.some((x) => x.sessionId === id)) ghosttyTerminals.delete(id);
  });
  try {
    await server.listen();
    sessions = server.sessions();
  } catch (err) {
    console.error(`[companion] socket server did not start: ${(err as Error).message}`);
  }

  /** Deletes the draft a successful Send used up. History keeps its text. The Send went out even if this fails. */
  function usedUp(payload: Outgoing): void {
    if (!payload.draftId) return;
    try {
      drafts.remove(payload.draftId);
      briefTouched({ draftId: payload.draftId });
    } catch (err) {
      console.warn(`[companion] could not delete the sent draft: ${(err as Error).message}`);
    }
  }

  function record(entry: Parameters<SendHistory['add']>[0], input: DeliveryInput): void {
    try {
      history.add(entry, { png: input.png, scene: input.scene });
    } catch (err) {
      console.warn(`[companion] could not record the send: ${(err as Error).message}`);
    }
  }

  /** Delivers to Claude Code and records the send in the history. */
  async function deliver(input: DeliveryInput) {
    const delivery = await server.deliver(input);
    record(
      {
        id: delivery.id,
        sentAt: delivery.createdAt,
        target: sessionName(delivery.sessionId),
        dir: delivery.dir,
        draft: delivery.draft,
        ...sent(input),
      },
      input,
    );
    return delivery;
  }

  /** Writes the bundle into `cwd`, then starts Claude Code there on it, or copies the command that does. */
  async function deliverToNew(payload: Outgoing, cwd: string, via: Launcher) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { ok: false, message: `No folder at ${cwd}` };
    const { input, warnings } = await composeOutgoing(payload);
    const sentAt = Date.now();
    const sketches = join(cwd, '.feedback', 'sketches');
    const id = freeId(sketches, sentAt);
    const dir = join(sketches, id);
    await writeBundle(dir, input);
    const draft = buildDraft(id, input);
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, draft);
    lastDelivery = input;
    rememberProjects([cwd]);
    const target = `new session (${LAUNCHER_NAMES[via]})`;
    record({ id, sentAt, target, dir, draft, ...sent(input) }, input);
    for (const w of warnings) console.warn(`[companion] ${w}`);
    if (via === 'copy') {
      const command = startCommand(cwd, promptPath);
      if (testMode) testClipboard = command;
      else clipboard.writeText(command);
      usedUp(payload);
      const what = input.png ? 'sketch' : 'draft';
      return { ok: true, message: `Copied a command that starts Claude Code on this ${what}. Paste it into a terminal.` };
    }
    await startSession(run, via, cwd, promptPath, herdrPath());
    usedUp(payload);
    return { ok: true, message: `Started Claude Code in ${LAUNCHER_NAMES[via]}` };
  }

  // COMPANION_UPDATE_URL points a packaged build at a local feed, also in test runs.
  const updateUrl = process.env.COMPANION_UPDATE_URL;
  if (app.isPackaged && updateUrl) autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
  const updater = new Updater({
    version: app.getVersion(),
    source: app.isPackaged && (!testMode || updateUrl) ? autoUpdater : undefined,
    onStatus: (status) => {
      send(CH.update, status);
      buildMenus();
    },
    beforeInstall: async () => {
      await flushAll();
      panel.prepareQuit();
    },
  });
  const checkForUpdates = () => {
    actions().openSettings();
    void updater.check();
  };

  const sessionName = (id: string | undefined) => {
    const s = sessions.sessions.find((x) => x.sessionId === id);
    return s?.title || s?.cwd.split('/').filter(Boolean).pop() || id || 'the session';
  };

  // Tests use a registrar that grabs nothing, so they never take the user's shortcut.
  const registrar: Registrar = testMode
    ? new FakeRegistrar()
    : { register: (a, fn) => globalShortcut.register(a, fn), unregister: (a) => globalShortcut.unregister(a) };
  const togglePanel = () => (panel.isVisible() ? panel.hide() : openStandalone());
  const hotkey = new Hotkey(registrar, togglePanel);
  const startup = hotkey.set(state.state.hotkey);
  if (!startup.ok) console.warn(`[companion] ${startup.error}`);
  /** Opens Write mode on a new note, from the capture shortcut and menus. A new thought picks no session, even with the panel up. */
  const newNote = () => {
    server.setTarget(undefined);
    setPrompt(undefined);
    panel.show();
    send(CH.newNote);
  };
  const captureKey = new Hotkey(registrar, newNote);
  const captureStartup = captureKey.set(state.state.captureHotkey);
  if (!captureStartup.ok) console.warn(`[companion] ${captureStartup.error}`);

  const runInstallCli = async (opts: { confirm: boolean; home?: string }): Promise<InstallResult | undefined> => {
    const home = opts.home ?? homedir();
    const source = cliSource();
    if (opts.confirm) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'Install the agent-brief command line tool?',
        detail: `This links ${cliLinkPath(home)} to ${source}, so Claude Code can run \`agent-brief\`.`,
      });
      if (response !== 0) return undefined;
    }
    try {
      const result = installCli({ source, home, pathEnv: await loginShellPath() });
      if (opts.confirm) {
        await dialog.showMessageBox({
          type: 'info',
          message: 'Installed the agent-brief command',
          detail: result.onPath
            ? `${result.link} is ready.`
            : `${result.link} is ready, but ${result.binDir} is not on your PATH. Add this line to ~/.zshrc:\n\nexport PATH="$HOME/.local/bin:$PATH"`,
        });
      }
      return result;
    } catch (err) {
      if (opts.confirm) dialog.showErrorBox('Could not install the agent-brief command', (err as Error).message);
      else throw err;
      return undefined;
    }
  };

  const actions = (): MenuActions => ({
    hotkey: state.state.hotkey,
    captureHotkey: state.state.captureHotkey,
    mode: state.state.mode,
    newNote,
    togglePanel,
    showPanel: openStandalone,
    newBoard: () => {
      openStandalone();
      send(CH.newBoard);
    },
    openSettings: () => {
      openStandalone();
      send(CH.openSettings);
    },
    installCli: () => void runInstallCli({ confirm: true }),
    update: updater.current(),
    checkForUpdates,
    installUpdate: () => void updater.install(),
  });

  let tray: Tray | undefined;
  const buildMenus = () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(actions())));
    tray?.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(actions())));
  };
  // The real tray stays out of test runs; tests inspect the template instead.
  if (!testMode) {
    const icons = join(app.getAppPath(), 'build/icons');
    const trayImage = nativeImage.createFromPath(join(icons, 'trayTemplate.png'));
    tray = new Tray(trayImage);
    if (trayImage.isEmpty()) tray.setTitle('✎');
    tray.setToolTip('Agent Brief');
    if (!app.isPackaged) app.dock?.setIcon(join(icons, 'icon-1024.png'));
  }
  buildMenus();
  updater.schedule();

  const applySettings = (patch: Partial<Settings>): SettingsResult => {
    const next: Partial<Settings> = {};
    if (patch.hotkey !== undefined) {
      const r = hotkey.set(patch.hotkey);
      if (!r.ok) return { ok: false, error: r.error, settings: settingsOf() };
      next.hotkey = r.hotkey;
    }
    if (patch.captureHotkey !== undefined) {
      const r = captureKey.set(patch.captureHotkey);
      if (!r.ok) return { ok: false, error: r.error, settings: settingsOf() };
      next.captureHotkey = r.hotkey;
    }
    if (patch.deliveryMode !== undefined) {
      if (patch.deliveryMode !== 'fill' && patch.deliveryMode !== 'submit') {
        return { ok: false, error: 'Delivery mode is fill or submit', settings: settingsOf() };
      }
      next.deliveryMode = patch.deliveryMode;
    }
    if (patch.openAtLogin !== undefined) {
      next.openAtLogin = !!patch.openAtLogin;
      // An unpackaged build would register the bare Electron binary, so only the real app does this.
      if (!testMode && app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.openAtLogin });
    }
    state.update(next);
    buildMenus();
    return { ok: true, settings: settingsOf() };
  };

  ipcMain.handle(
    CH.init,
    (): InitInfo => ({
      currentBoard: state.state.currentBoard,
      home: homedir(),
      prompt,
      sessions,
      testMode,
      theme: theme(),
      settings: settingsOf(),
      panelVisible: panel.isVisible(),
      mode: state.state.mode,
    }),
  );
  ipcMain.handle(CH.listBoards, () => store.list());
  ipcMain.handle(CH.loadBoard, (_e, name: string) => store.load(name));
  ipcMain.handle(CH.saveBoard, (_e, name: string, json: string) => {
    store.saveScene(name, json);
    briefTouched({ board: name });
  });
  ipcMain.handle(CH.saveNotes, (_e, name: string, text: string) => {
    store.saveNotes(name, text);
    briefTouched({ board: name });
  });
  ipcMain.handle(CH.createBoard, (_e, name: string) => store.create(name));
  ipcMain.handle(CH.renameBoard, (_e, from: string, to: string) => {
    const name = store.rename(from, to);
    if (state.state.currentBoard === from) state.update({ currentBoard: name });
    drafts.renameBoard(from, name);
    state.update({ sessionBriefs: renameInBriefs(briefs(), from, name) });
    publishBriefs();
    return name;
  });
  ipcMain.handle(CH.setCurrent, (_e, raw: string) => {
    const board = store.create(raw);
    state.update({ currentBoard: board });
    const target = server.sessions().targetSessionId;
    if (board === restoredBoard) restoredBoard = undefined;
    else if (target) rememberBrief(target, { board, last: 'board' }, false);
  });
  ipcMain.handle(CH.setTarget, (_e, sessionId: string | undefined) => {
    try {
      server.setTarget(sessionId);
    } catch (err) {
      console.warn(`[companion] ${(err as Error).message}`);
    }
  });
  ipcMain.handle(CH.send, async (_e, payload: Outgoing) => {
    if (!server.sessions().targetSessionId) {
      lastDelivery = (await composeOutgoing(isTextPayload(payload) ? payload : { ...payload, segments: [] })).input;
      return { ok: false, message: 'Choose a session to send to.' };
    }
    try {
      const { input, warnings } = await composeOutgoing(payload);
      lastDelivery = input;
      const delivery = await deliver(input);
      usedUp(payload);
      for (const w of warnings) console.warn(`[companion] ${w}`);
      const note = warnings.length ? ` (${warnings[0]})` : '';
      return { ok: true, message: `Sent to ${sessionName(delivery.sessionId)}${note}` };
    } catch (err) {
      return { ok: false, message: `Send failed: ${(err as Error).message}` };
    }
  });
  ipcMain.handle(CH.getSettings, () => settingsOf());
  ipcMain.handle(CH.setSettings, (_e, patch: Partial<Settings>) => applySettings(patch ?? {}));
  ipcMain.handle(CH.mic, () => microphoneAccess());
  ipcMain.on(CH.hide, () => panel.hide());
  ipcMain.handle(CH.updateGet, () => updater.current());
  ipcMain.handle(CH.updateCheck, () => updater.check());
  ipcMain.handle(CH.updateInstall, () => updater.install());
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
  ipcMain.handle(CH.listDrafts, () => drafts.list());
  ipcMain.handle(CH.saveDraft, (_e, raw: unknown) => {
    const draft = drafts.save(raw);
    briefTouched({ draftId: draft.id });
  });
  ipcMain.handle(CH.deleteDraft, (_e, id: string) => {
    drafts.remove(id);
    briefTouched({ draftId: id });
  });
  ipcMain.handle(CH.listBriefs, () => briefEntries());
  ipcMain.handle(CH.switchBrief, async (_e, sessionId: string) => {
    const b = briefs()[sessionId];
    if (!b) throw new Error('that session has no brief');
    // An ended session can no longer take a Send, so its brief opens with no target.
    server.setTarget(liveSession(sessionId) ? sessionId : undefined);
    setPrompt(undefined);
    const draft = b.draftId && drafts.get(b.draftId) ? b.draftId : undefined;
    const board = b.board && store.exists(b.board) ? b.board : undefined;
    if (draft && (b.last === 'draft' || !board)) send(CH.openDraft, draft);
    else await bridge.request('show', { board: board ?? store.create(sessionBoard(sessionId)) });
    publishBriefs();
  });
  ipcMain.handle(CH.forgetBrief, (_e, sessionId: string) => {
    const { [sessionId]: _gone, ...rest } = briefs();
    state.update({ sessionBriefs: rest });
    publishBriefs();
  });
  ipcMain.handle(CH.listTemplates, () => templates.list());
  ipcMain.handle(CH.saveTemplate, (_e, template: unknown) => templates.save(template));
  ipcMain.handle(CH.deleteTemplate, (_e, id: string) => templates.remove(id));
  ipcMain.on(CH.setMode, (_e, mode: Mode) => {
    if (mode !== 'sketch' && mode !== 'write') return;
    state.update({ mode });
    buildMenus();
  });
  ipcMain.handle(
    CH.launchOptions,
    (): LaunchOptions => ({ launchers: launchers(), recentProjects: state.state.recentProjects ?? [] }),
  );
  ipcMain.handle(CH.chooseFolder, async () => {
    if (testMode) return process.env.COMPANION_TEST_FOLDER;
    const picked = await dialog.showOpenDialog(panel.win, {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use Folder',
    });
    return picked.canceled ? undefined : picked.filePaths[0];
  });
  ipcMain.handle(CH.sendNew, async (_e, payload: Outgoing, target: { cwd: string; via: Launcher }) => {
    try {
      return await deliverToNew(payload, target.cwd, target.via);
    } catch (err) {
      return { ok: false, message: `Could not start Claude Code: ${(err as Error).message}` };
    }
  });
  ipcMain.handle(CH.focusSession, async (_e, id: string) => {
    const s = server.sessions().sessions.find((x) => x.sessionId === id);
    if (!s) return;
    await focusSession(run, s, { herdr: herdrPath(), ghosttyTerminal: ghosttyTerminals.get(id) }).catch((err) =>
      console.warn(`[companion] could not focus the session: ${(err as Error).message}`),
    );
  });
  ipcMain.on(CH.ready, () => bridge.ready());
  ipcMain.on(CH.reply, (_e, reply: BoardReply) => bridge.handleReply(reply));

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
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('activate', openStandalone);
  app.on('second-instance', openStandalone);

  if (testMode) {
    Object.assign(globalThis, {
      __companion: {
        backend,
        server,
        socketPath,
        panel,
        store,
        state,
        dataDir,
        hotkey,
        captureKey,
        newNote,
        drafts,
        templates,
        registrar,
        toggle: togglePanel,
        buildDelivery: async () => (await composeFrom(await bridge.request('payload', {}))).input,
        lastDelivery: () => lastDelivery,
        applySettings,
        installCli: (home: string) => runInstallCli({ confirm: false, home }),
        trayMenu: () => trayMenuTemplate(actions()).map((i) => i.label ?? i.type),
        history,
        launches,
        clipboard: () => testClipboard,
        ghosttyTerminals,
        updater,
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
