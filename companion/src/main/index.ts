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
import { SyncHub } from '../web/sync-hub';
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
  type Settings,
  type SettingsResult,
  type Theme,
} from '../shared/ipc';
import { createBoardBackend } from './backend';
import { newDraftId } from '../shared/drafts';
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
import { HubLink } from './hub-link';
import { Ipad } from './ipad';
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
  const backend: BoardBackend = {
    ...baseBackend,
    async open(req) {
      // The user just typed /sketch, so the session's terminal is still in front.
      const s = server.sessions().sessions.find((x) => x.sessionId === req.sessionId);
      if (s && isGhostty(s.host)) {
        const id = await frontGhosttyTerminal(run, s.cwd);
        if (id) ghosttyTerminals.set(s.sessionId, id);
      }
      return baseBackend.open(req);
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

  // One sync hub per app: the Mac panel, Claude's draws and every iPad client meet here.
  const hub = new SyncHub();
  const hubLink = new HubLink({
    hub,
    store,
    currentBoard: () => state.state.currentBoard,
    toRenderer: (board, elements) => send(CH.remoteElements, board, elements),
  });
  const ipad = new Ipad({
    hub,
    staticDir: join(__dirname, '../web'),
    devicesFile: join(dataDir, 'devices.json'),
    deliver: (input) => deliverFromDevice(input),
    currentBoard: () => state.state.currentBoard,
    destination: () => {
      const id = server.sessions().targetSessionId;
      return id ? { sessionId: id, label: sessionName(id) } : undefined;
    },
    // Tests bind to loopback on a free port.
    host: testMode ? (process.env.COMPANION_WEB_HOST ?? '127.0.0.1') : undefined,
    port: testMode ? Number(process.env.COMPANION_WEB_PORT ?? 0) : undefined,
    introShown: () => !!state.state.ipadIntroShown,
    markIntroShown: () => state.update({ ipadIntroShown: true }),
    onStatus: (status) => send(CH.ipad, status, false),
  });
  server.onSessionsChange(() => ipad.destinationChanged());
  /**
   * A Send from the iPad. When the Mac records voice on that board, the Mac's
   * clip, stroke log and numbered PNG go with it; otherwise the iPad's sketch goes as is.
   */
  async function deliverFromDevice(input: DeliveryInput) {
    if (!input.sessionId && !server.sessions().targetSessionId) {
      throw new Error('Choose a Claude Code session on the Mac first.');
    }
    const mac = await bridge.request('voicePayload', { board: input.boardName }).catch(() => null);
    const clear = () => bridge.request('clearBoard', { board: input.boardName }).catch(() => undefined);
    if (!mac) {
      const delivery = await deliver(input);
      await clear();
      return delivery;
    }
    const { input: composed, warnings } = await composeFrom({ ...mac, notes: input.notes ?? mac.notes });
    for (const w of warnings) console.warn(`[companion] ${w}`);
    const delivery = await deliver({ ...composed, sessionId: input.sessionId });
    lastDelivery = composed;
    await clear();
    return delivery;
  }

  const openIpad = async () => {
    openStandalone();
    send(CH.ipad, await ipad.open(), true);
  };

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
    openIpad: () => void openIpad(),
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
    hubLink.saved(name, json);
  });
  ipcMain.handle(CH.saveNotes, (_e, name: string, text: string) => store.saveNotes(name, text));
  ipcMain.handle(CH.createBoard, (_e, name: string) => store.create(name));
  ipcMain.handle(CH.renameBoard, (_e, from: string, to: string) => {
    const name = store.rename(from, to);
    if (state.state.currentBoard === from) state.update({ currentBoard: name });
    drafts.renameBoard(from, name);
    return name;
  });
  ipcMain.handle(CH.setCurrent, (_e, name: string) => state.update({ currentBoard: store.create(name) }));
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
  ipcMain.on(CH.pushElements, (_e, board: string, elements: unknown[]) => hubLink.pushed(board, elements));
  ipcMain.handle(CH.updateGet, () => updater.current());
  ipcMain.handle(CH.updateCheck, () => updater.check());
  ipcMain.handle(CH.updateInstall, () => updater.install());
  ipcMain.handle(CH.ipadOpen, () => ipad.open());
  ipcMain.handle(CH.ipadStop, () => ipad.stop());
  ipcMain.handle(CH.ipadRevoke, (_e, id: string) => ipad.revoke(id));
  ipcMain.handle(CH.historyList, () => history.list().map((e) => ({ ...e, png: history.png(e.id) })));
  ipcMain.handle(CH.historyRestore, (_e, id: string) => {
    const entry = history.get(id);
    const scene = history.scene(id);
    if (!entry || (scene === undefined && !entry.text)) throw new Error('that send is no longer in the history');
    let board: string | undefined;
    if (entry.board && scene !== undefined) {
      board = store.create(restoredBoardName(entry.board, entry.sentAt, (n) => store.exists(n)));
      store.saveScene(board, scene);
      if (entry.notes) store.saveNotes(board, entry.notes);
      hubLink.saved(board, scene);
    }
    if (!entry.text) return { board };
    const now = Date.now();
    const draft = drafts.save({ id: newDraftId(now), body: entry.text, status: 'note', board, rank: 0, createdAt: now, updatedAt: now });
    return { board, draftId: draft.id };
  });
  ipcMain.handle(CH.listDrafts, () => drafts.list());
  ipcMain.handle(CH.saveDraft, (_e, draft: unknown) => void drafts.save(draft));
  ipcMain.handle(CH.deleteDraft, (_e, id: string) => drafts.remove(id));
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
      .then(() => {
        hubLink.flush();
        return Promise.all([server.close(), ipad.stop()]);
      })
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
        hub,
        ipad,
        openIpad,
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
