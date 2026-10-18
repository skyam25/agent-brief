import { contextBridge, ipcRenderer } from 'electron';
import { createPreloadApi } from './api';

contextBridge.exposeInMainWorld('companion', createPreloadApi(ipcRenderer));
