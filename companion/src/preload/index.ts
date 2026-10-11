import { contextBridge, ipcRenderer } from 'electron';
import { CH, type BoardRequest, type CompanionApi } from '../shared/ipc';

const api: CompanionApi = {
  init: () => ipcRenderer.invoke(CH.init),
  listBoards: () => ipcRenderer.invoke(CH.listBoards),
  loadBoard: (name) => ipcRenderer.invoke(CH.loadBoard, name),
  saveBoard: (name, json) => ipcRenderer.invoke(CH.saveBoard, name, json),
  saveNotes: (name, text) => ipcRenderer.invoke(CH.saveNotes, name, text),
  createBoard: (name) => ipcRenderer.invoke(CH.createBoard, name),
  renameBoard: (from, to) => ipcRenderer.invoke(CH.renameBoard, from, to),
  setCurrent: (name) => ipcRenderer.invoke(CH.setCurrent, name),
  send: (payload) => ipcRenderer.invoke(CH.send, payload),
  setTarget: (sessionId) => ipcRenderer.invoke(CH.setTarget, sessionId),
  onRequest: (handler) => {
    ipcRenderer.on(CH.request, async (_e, req: BoardRequest) => {
      ipcRenderer.send(CH.reply, await handler(req));
    });
  },
  ready: () => ipcRenderer.send(CH.ready),
  onPrompt: (fn) => ipcRenderer.on(CH.prompt, (_e, prompt) => fn(prompt)),
  onSessions: (fn) => ipcRenderer.on(CH.sessions, (_e, s) => fn(s)),
  onTheme: (fn) => ipcRenderer.on(CH.theme, (_e, theme) => fn(theme)),
  hidePanel: () => ipcRenderer.send(CH.hide),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(CH.setSettings, patch),
  requestMicrophone: () => ipcRenderer.invoke(CH.mic),
  onOpenSettings: (fn) => ipcRenderer.on(CH.openSettings, () => fn()),
  onNewBoard: (fn) => ipcRenderer.on(CH.newBoard, () => fn()),
  listHistory: () => ipcRenderer.invoke(CH.historyList),
  restoreHistory: (id) => ipcRenderer.invoke(CH.historyRestore, id),
  launchOptions: () => ipcRenderer.invoke(CH.launchOptions),
  chooseFolder: () => ipcRenderer.invoke(CH.chooseFolder),
  sendNew: (payload, target) => ipcRenderer.invoke(CH.sendNew, payload, target),
  focusSession: (id) => ipcRenderer.invoke(CH.focusSession, id),
  getUpdate: () => ipcRenderer.invoke(CH.updateGet),
  checkForUpdate: () => ipcRenderer.invoke(CH.updateCheck),
  installUpdate: () => ipcRenderer.invoke(CH.updateInstall),
  onUpdate: (fn) => ipcRenderer.on(CH.update, (_e, status) => fn(status)),
  onVisibility: (fn) => ipcRenderer.on(CH.visibility, (_e, visible) => fn(visible)),
};

contextBridge.exposeInMainWorld('companion', api);
