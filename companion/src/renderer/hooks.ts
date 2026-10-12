/** Hooks the panel's views share. */

import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

/** Re-renders when a store with a `version` changes, and returns the store. */
export function useStore<T extends { version: number; subscribe(fn: () => void): () => void }>(store: T): T {
  useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.version,
  );
  return store;
}

/** Closes a menu on Escape. The menu carries `data-escape-owner`, so the panel stays up. */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/**
 * Calls `onOutside` when a press lands outside `ref`'s element. With `parent`,
 * the element's parent counts as inside, since it holds the button that toggles it.
 */
export function usePointerOutside(
  ref: RefObject<Element | null>,
  onOutside: () => void,
  opts: { active?: boolean; parent?: boolean } = {},
): void {
  const { active = true, parent = false } = opts;
  const latest = useRef(onOutside);
  latest.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      const root = parent ? ref.current?.parentElement : ref.current;
      if (root && !root.contains(e.target as Node)) latest.current();
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, [ref, active, parent]);
}
