/**
 * Comment pins on the boards, kept in memory per board until a Send takes them.
 * They float over the board in their own layer and never enter the scene.
 */

import type { BoardComments, BoardPin } from '../shared/board-comments';
import { MAX_PINS } from '../shared/board-comments';
import { OVERALL } from './review-voice';

const EMPTY: BoardComments = { overall: '', pins: [] };

let seq = 0;
const pinId = () => `bp-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export class BoardCommentsStore {
  /** The comment tool is on: a click on the board drops a pin. */
  tool = false;
  /** The pin the mic and the keyboard act on. Undefined is the overall note. */
  selected?: string;
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  private readonly boards = new Map<string, BoardComments>();
  private readonly listeners = new Set<() => void>();

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
    this.emit();
  }

  private change(board: string, fn: (c: BoardComments) => BoardComments): void {
    this.boards.set(board, fn(this.of(board)));
    this.emit();
  }

  add(board: string, pin: Omit<BoardPin, 'id' | 'text' | 'createdAt'>): string | undefined {
    if (this.of(board).pins.length >= MAX_PINS) return undefined;
    const id = pinId();
    this.selected = id;
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

  /** Empties a board's comments after a Send and turns the tool off. */
  clear(board: string): void {
    this.boards.delete(board);
    this.selected = undefined;
    this.tool = false;
    this.emit();
  }
}
