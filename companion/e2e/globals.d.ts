import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { SendHistory } from '../src/main/history';
import type { DraftStore } from '../src/main/drafts';
import type { FakeRegistrar, Hotkey } from '../src/main/hotkey';
import type { Installs } from '../src/main/installs';
import type { Panel } from '../src/main/panel';
import type { BoardStore, StateFile } from '../src/main/store';
import type { Terminals } from '../src/main/terminals';
import type { BoardController } from '../src/renderer/controller';
import type { DraftBook } from '../src/renderer/drafts';
import type { TemplateShelf } from '../src/renderer/templates';
import type { BoardBackend, DeliveryInput } from '../src/server/contract';
import type { Settings, SettingsResult } from '../src/shared/ipc';

/** What main assigns to `globalThis.__companion` in test mode. */
interface CompanionTestHooks {
  backend: BoardBackend;
  panel: Panel;
  store: BoardStore;
  state: StateFile;
  hotkey: Hotkey;
  newNote(): void;
  drafts: DraftStore;
  registrar: FakeRegistrar;
  toggle(): void;
  buildDelivery(): Promise<DeliveryInput>;
  applySettings(patch: Partial<Settings>): SettingsResult;
  installCli(home: string): ReturnType<Installs['installCli']>;
  installPlugin(): ReturnType<Installs['installPlugin']>;
  trayMenu(): (string | undefined)[];
  history: SendHistory;
  launches: Terminals['launches'];
  clipboard(): Terminals['copied'];
  openedOutputs: string[];
}

declare global {
  /** What the renderer assigns to `window` in test mode. */
  interface Window {
    __board: BoardController;
    __excalidraw: ExcalidrawImperativeAPI;
    __drafts: DraftBook;
    __templates: TemplateShelf;
  }

  var __companion: CompanionTestHooks;
}
