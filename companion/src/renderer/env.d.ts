import type { CompanionApi } from '../shared/ipc';

declare global {
  interface Window {
    companion: CompanionApi;
    /** The spell checker, absent outside Electron. */
    spelling?: { isMisspelled(word: string): boolean };
  }
}
