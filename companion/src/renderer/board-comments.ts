/**
 * Comment pins on boards, autosaved separately from their scenes until sent.
 * They float over the board in their own layer and never enter the scene.
 */

import type { BoardComments, BoardPin } from '../shared/board-comments';
import { MAX_PINS } from '../shared/board-comments';
import type { CompanionApi } from '../shared/ipc';
import { SaveQueue } from './save-queue';
import { OVERALL } from './review-voice';

const EMPTY: BoardComments = { overall: '', pins: [] };

let seq = 0;
const pinId = () => `bp-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export class BoardCommentsStore {
  /** The comment tool is on: a click on the board drops a pin. */
  tool = false;
  /** The pin the mic and the keyboard act on. Undefined is the overall note. */
  selected?: string;
  /** Epoch ms of the click that set `selected`, so voice moves from the click, not the next render. */
  selectedAt = 0;
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  private readonly boards = new Map<string, BoardComments>();
  private readonly owners = new WeakMap<BoardComments, { board?: string }>();
  private readonly listeners = new Set<() => void>();

  private host?: Pick<CompanionApi, 'listBoardComments' | 'saveBoardComments'>;
  private readonly saves = new SaveQueue(async (board) => {
    if (!this.host) return false;
    await this.host.saveBoardComments(board, this.of(board));
    return true;
  }, () => this.emit());

  constructor(host?: Pick<CompanionApi, 'listBoardComments' | 'saveBoardComments'>) {
    this.host = host;
  }

  get saveError(): string | undefined { return this.saves.error; }

  async connect(host: NonNullable<BoardCommentsStore['host']>): Promise<void> {
    this.host = host;
    await this.load();
  }

  async load(): Promise<void> {
    if (!this.host) return;
    const saved = await this.host.listBoardComments();
    for (const [board, comments] of Object.entries(saved)) {
      if (!this.saves.has(board)) {
        this.boards.set(board, comments);
        this.owners.set(comments, { board });
      }
    }
    this.emit();
  }

  async flush(): Promise<void> {
    await this.saves.flush();
    if (this.saveError) throw new Error(this.saveError);
  }

  /** Main moved the saved file; pending edits now belong to the new name too. */
  rename(from: string, to: string): void {
    if (from === to) return;
    const comments = this.boards.get(from);
    this.saves.cancel(from);
    this.boards.delete(from);
    if (comments) {
      this.boards.set(to, comments);
      const owner = this.owners.get(comments);
      if (owner) owner.board = to;
      if (this.host) this.saves.schedule(to);
    }
    this.emit();
  }

  /** Main trashed the board and its comments file. */
  forget(board: string): void {
    this.saves.cancel(board);
    if (this.of(board).pins.some((p) => p.id === this.selected)) this.selected = undefined;
    const owner = this.owners.get(this.of(board));
    if (owner) owner.board = undefined;
    this.boards.delete(board);
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  of(board: string): BoardComments {
    return this.boards.get(board) ?? EMPTY;
  }

  /** The column shows while the tool is on or the board has something in it. */
  showing(board: string): boolean {
    const c = this.of(board);
    return this.tool || c.pins.length > 0 || !!c.overall.trim();
  }

  /** True when `id` names a pin on any board. */
  owns(id: string): boolean {
    for (const c of this.boards.values()) if (c.pins.some((p) => p.id === id)) return true;
    return false;
  }

  setTool(on: boolean): void {
    if (this.tool === on) return;
    this.tool = on;
    this.emit();
  }

  select(id: string | undefined): void {
    if (this.selected === id) return;
    this.selected = id;
    this.selectedAt = Date.now();
    this.emit();
  }

  private change(board: string, fn: (c: BoardComments) => BoardComments): void {
    const owner = this.owners.get(this.of(board)) ?? { board };
    const next = fn(this.of(board));
    this.boards.set(board, next);
    this.owners.set(next, owner);
    if (this.host) this.saves.schedule(board);
    this.emit();
  }

  add(board: string, pin: Omit<BoardPin, 'id' | 'text' | 'createdAt'>): string | undefined {
    if (this.of(board).pins.length >= MAX_PINS) return undefined;
    const id = pinId();
    this.selected = id;
    this.selectedAt = Date.now();
    this.change(board, (c) => ({ ...c, pins: [...c.pins, { ...pin, id, text: '', createdAt: Date.now() }] }));
    return id;
  }

  edit(board: string, id: string, text: string): void {
    this.change(board, (c) => ({ ...c, pins: c.pins.map((p) => (p.id === id ? { ...p, text } : p)) }));
  }

  setOverall(board: string, overall: string): void {
    this.change(board, (c) => ({ ...c, overall }));
  }

  remove(board: string, id: string): void {
    if (this.selected === id) this.selected = undefined;
    this.change(board, (c) => ({ ...c, pins: c.pins.filter((p) => p.id !== id) }));
  }

  /** Adds words the mic heard to a pin, or to the overall note, on whichever board holds it. */
  append(board: string, target: string, words: string): void {
    const join = (before: string) => (before.trim() ? `${before.trimEnd()} ${words}` : words);
    if (target === OVERALL) {
      this.setOverall(board, join(this.of(board).overall));
      return;
    }
    for (const [name, c] of this.boards) {
      const pin = c.pins.find((p) => p.id === target);
      if (pin) return this.edit(name, target, join(pin.text));
    }
  }

  /** Removes only the comments that went out; later edits stay queued. */
  consume(board: string, sent: BoardComments): string | undefined {
    const owner = this.owners.get(sent);
    if (owner && !owner.board) return; // The board was deleted while sending.
    board = owner?.board ?? board;
    const delivered = new Map(sent.pins.map((p) => [p.id, JSON.stringify(p)]));
    const current = this.of(board);
    const next = {
      overall: current.overall === sent.overall ? '' : current.overall,
      pins: current.pins.filter((p) => delivered.get(p.id) !== JSON.stringify(p)),
    };
    if (current.pins.some((p) => p.id === this.selected) && !next.pins.some((p) => p.id === this.selected)) this.selected = undefined;
    this.change(board, () => next);
    return board;
  }

  /** Empties a board's comments after a Send and turns the tool off. */
  clear(board: string): void {
    this.selected = undefined;
    this.tool = false;
    this.change(board, () => ({ overall: '', pins: [] }));
  }
}
