/** Escape hides the panel only when nothing on it would use the key. */

/** The appState fields that mean Excalidraw is in the middle of something. */
interface EditorState {
  openDialog?: unknown;
  openMenu?: unknown;
  openPopup?: unknown;
  openSidebar?: unknown;
  contextMenu?: unknown;
  editingTextElement?: unknown;
  newElement?: unknown;
  multiElement?: unknown;
  selectionElement?: unknown;
  selectedElementIds?: Record<string, unknown>;
}

const OPEN_OVERLAYS = [
  '.excalidraw .Modal',
  '.excalidraw .dropdown-menu',
  '.excalidraw .context-menu',
  '.excalidraw .popover',
  '[data-radix-popper-content-wrapper]',
].join(', ');

export function shouldHideOnEscape(state: EditorState, doc: Document): boolean {
  const active = doc.activeElement as HTMLElement | null;
  if (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) return false;
  if (doc.querySelector(OPEN_OVERLAYS)) return false;
  const busy =
    state.openDialog ||
    state.openMenu ||
    state.openPopup ||
    state.openSidebar ||
    state.contextMenu ||
    state.editingTextElement ||
    state.newElement ||
    state.multiElement ||
    state.selectionElement;
  if (busy) return false;
  return Object.keys(state.selectedElementIds ?? {}).length === 0;
}
