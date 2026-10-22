import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createPreloadApi } from './api';

contextBridge.exposeInMainWorld('companion', createPreloadApi(ipcRenderer));
contextBridge.exposeInMainWorld('spelling', { isMisspelled: (word: string) => webFrame.isWordMisspelled(word) });
