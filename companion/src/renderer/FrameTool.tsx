import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A frame button in Excalidraw's main toolbar, which otherwise keeps frames in its More tools menu.
 * Excalidraw has no slot for toolbar buttons, so this portals one in after the eraser.
 */
export function FrameTool({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement }) {
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.className = 'frame-tool-host';
    return el;
  });
  const [active, setActive] = useState(() => api.getAppState().activeTool.type === 'frame');

  // Excalidraw rebuilds the toolbar in some modes, so this puts the button back whenever it goes missing.
  useEffect(() => {
    const place = () => {
      const row = root.querySelector('.App-toolbar .Stack_horizontal');
      if (!row || host.parentElement === row) return;
      const dividers = row.querySelectorAll(':scope > .App-toolbar__divider');
      row.insertBefore(host, dividers[dividers.length - 1] ?? null);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      host.remove();
    };
  }, [root, host]);

  useEffect(
    () =>
      api.onChange((_elements, appState) => {
        const isFrame = appState.activeTool.type === 'frame';
        setActive(isFrame);
        root.dataset.frameTool = String(isFrame);
      }),
    [api, root],
  );

  return createPortal(
    <label className="ToolIcon Shape" title="Frame tool — F">
      <input
        className="ToolIcon_type_radio ToolIcon_size_medium"
        type="radio"
        aria-label="Frame tool"
        aria-keyshortcuts="F"
        data-testid="toolbar-frame-button"
        checked={active}
        onChange={() => api.setActiveTool({ type: 'frame' })}
      />
      <div className="ToolIcon__icon">
        <svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h16M4 17h16M7 4v16M17 4v16" />
        </svg>
        <span className="ToolIcon__keybinding">F</span>
      </div>
    </label>,
    host,
  );
}
