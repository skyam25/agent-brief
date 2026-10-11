/** Boards and notes on disk: `<dataDir>/boards/<name>.excalidraw` and `<name>.notes.md`. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_BOARD } from '../protocol';
import type { BoardEntry, Mode, Settings } from '../shared/ipc';
import { badRequest, notFound, BoardError } from '../board/errors';

const SCENE_EXT = '.excalidraw';
const NOTES_EXT = '.notes.md';

export const DEFAULT_BOARD = 'scratch';

/** What the app keeps in its data folder, as opposed to Chromium's caches. */
const DATA_ENTRIES = ['boards', 'drafts', 'templates', 'history', 'state.json', 'devices.json'];

/**
 * Moves the app's data from the folder it used under an earlier name. Runs
 * once: it does nothing when the old folder has no boards or the new one has.
 */
export function migrateData(oldDir: string, newDir: string): boolean {
  if (!existsSync(join(oldDir, 'boards')) || existsSync(join(newDir, 'boards'))) return false;
  if (!existsSync(newDir)) {
    renameSync(oldDir, newDir);
    return true;
  }
  for (const name of DATA_ENTRIES) {
    const from = join(oldDir, name);
    if (existsSync(from)) renameSync(from, join(newDir, name));
  }
  return true;
}

export function emptyScene(): string {
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'agent-brief',
      elements: [],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    },
    null,
    2,
  );
}

/** Trims a board name and rejects ones that are unsafe as file names. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('board name must be a string');
  const name = raw.trim();
  if (!name || name.length > 64) throw badRequest('board name must be 1 to 64 characters');
  if (!/^[\w][\w .-]*$/u.test(name)) {
    throw badRequest('board name may use letters, digits, spaces, dots, dashes and underscores');
  }
  if (name === CURRENT_BOARD) throw badRequest(`"${CURRENT_BOARD}" is reserved`);
  return name;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class BoardStore {
  readonly dir: string;
  private readonly created = new Set<(name: string) => void>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'boards');
    mkdirSync(this.dir, { recursive: true });
  }

  private scenePath(name: string): string {
    return join(this.dir, cleanName(name) + SCENE_EXT);
  }

  private notesPath(name: string): string {
    return join(this.dir, cleanName(name) + NOTES_EXT);
  }

  exists(name: string): boolean {
    return existsSync(this.scenePath(name));
  }

  list(): BoardEntry[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(SCENE_EXT))
      .map((f) => {
        const name = f.slice(0, -SCENE_EXT.length);
        const path = join(this.dir, f);
        let elementCount = 0;
        try {
          const scene = JSON.parse(readFileSync(path, 'utf8')) as { elements?: { isDeleted?: boolean }[] };
          elementCount = (scene.elements ?? []).filter((e) => !e.isDeleted).length;
        } catch {
          elementCount = 0;
        }
        return { name, updatedAt: statSync(path).mtimeMs, elementCount };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates the board when missing. Returns the cleaned name. */
  create(raw: string): string {
    const name = cleanName(raw);
    if (!this.exists(name)) {
      writeAtomic(this.scenePath(name), emptyScene());
      for (const fn of this.created) fn(name);
    }
    return name;
  }

  /** Fires when a board file is created, however it was asked for. */
  onCreate(fn: (name: string) => void): void {
    this.created.add(fn);
  }

  load(name: string): { scene: string | null; notes: string } {
    const scenePath = this.scenePath(name);
    const notesPath = this.notesPath(name);
    return {
      scene: existsSync(scenePath) ? readFileSync(scenePath, 'utf8') : null,
      notes: existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '',
    };
  }

  saveScene(name: string, json: string): void {
    writeAtomic(this.scenePath(name), json);
  }

  saveNotes(name: string, text: string): void {
    writeAtomic(this.notesPath(name), text);
  }

  rename(fromRaw: string, toRaw: string): string {
    const from = cleanName(fromRaw);
    const to = cleanName(toRaw);
    if (from === to) return to;
    if (!this.exists(from)) throw notFound(`no board named ${JSON.stringify(from)}`);
    if (this.exists(to)) throw new BoardError('conflict', `a board named ${JSON.stringify(to)} exists`);
    renameSync(this.scenePath(from), this.scenePath(to));
    if (existsSync(this.notesPath(from))) renameSync(this.notesPath(from), this.notesPath(to));
    for (const fn of this.created) fn(to);
    return to;
  }
}

export interface AppState extends Settings {
  currentBoard: string;
  width: number;
  height: number;
  /** Set once the macOS firewall note for the iPad server was shown. */
  ipadIntroShown?: boolean;
  /** Project folders Claude Code sessions ran in, most recent first. */
  recentProjects?: string[];
  /** The mode the panel was last in. */
  mode: Mode;
}

export const DEFAULT_STATE: AppState = {
  currentBoard: DEFAULT_BOARD,
  width: 1100,
  height: 760,
  hotkey: 'Control+Alt+S',
  deliveryMode: 'submit',
  openAtLogin: false,
  captureHotkey: 'Control+Alt+N',
  mode: 'sketch',
};

/** Panel size, current board and settings in `<dataDir>/state.json`. */
export class StateFile {
  private readonly path: string;
  state: AppState;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'state.json');
    let saved: Partial<AppState> = {};
    try {
      saved = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      saved = {};
    }
    this.state = { ...DEFAULT_STATE, ...saved };
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    writeAtomic(this.path, JSON.stringify(this.state, null, 2));
  }
}
