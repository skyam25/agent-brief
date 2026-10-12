import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Theme } from '../shared/ipc';
import type { BoardController, LoadedScene } from './controller';
import { FrameTool } from './FrameTool';
import { installPen } from './pen';
import { imageFiles } from './stack';

const editable = (t: Element | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

/** The Excalidraw canvas with pen handling, trimmed to drawing: no main menu, library or help. */
export function BoardCanvas(props: {
  controller: BoardController;
  scene: LoadedScene;
  theme: Theme;
  /** False while another view covers the board, so pastes there are not the board's. */
  active: boolean;
  onReady: (api: ExcalidrawImperativeAPI) => void;
}) {
  const { controller, onReady } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const active = useRef(props.active);
  active.current = props.active;

  useEffect(() => {
    const pen = installPen(() => ref.current);
    // Keyboard shortcuts such as Cmd+Z reach Excalidraw only when it holds focus.
    const focusCanvas = () => {
      if (document.activeElement === document.body) ref.current?.querySelector<HTMLElement>('.excalidraw')?.focus();
    };
    window.addEventListener('focus', focusCanvas);
    // Excalidraw inserts pasted images before its onPaste callback runs, so this listens to the event itself.
    // A Stack board takes image pastes and drops itself: Excalidraw keeps only the first file and places it at the pointer.
    const onPaste = (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData?.files);
      const focused = document.activeElement;
      if (controller.layout === 'stack' && files.length && onBoard(focused) && !editable(focused)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void controller.addScreenshots(files);
        return;
      }
      controller.afterPaste();
    };
    const onDrop = (e: DragEvent) => {
      const files = imageFiles(e.dataTransfer?.files);
      if (controller.layout !== 'stack' || !files.length || !controller.api || !active.current) return;
      e.preventDefault();
      e.stopPropagation();
      const { offsetLeft, offsetTop, scrollX, scrollY, zoom } = controller.api.getAppState();
      const at = { x: (e.clientX - offsetLeft) / zoom.value - scrollX, y: (e.clientY - offsetTop) / zoom.value - scrollY };
      void controller.addScreenshots(files, at);
    };
    const onBoard = (focused: Element | null) =>
      active.current && (!focused || focused === document.body || !!ref.current?.contains(focused));
    document.addEventListener('paste', onPaste, { capture: true });
    ref.current?.addEventListener('drop', onDrop, { capture: true });
    const root = ref.current;
    return () => {
      pen.dispose();
      window.removeEventListener('focus', focusCanvas);
      document.removeEventListener('paste', onPaste, { capture: true });
      root?.removeEventListener('drop', onDrop, { capture: true });
    };
  }, [controller]);

  const onApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (controller.api) return;
      controller.attach(api);
      onReady(api);
      setApi(api);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.excalidraw')?.focus());
    },
    [controller, onReady],
  );

  return (
    <div className="canvas" ref={ref} data-testid="canvas">
      <Excalidraw
        excalidrawAPI={onApi}
        theme={props.theme}
        initialData={{
          elements: props.scene.elements,
          appState: { ...props.scene.appState, activeTool: { type: 'selection' } as never },
          files: props.scene.files,
          scrollToContent: true,
        }}
        onChange={(elements, appState) => {
          controller.handleChange(elements);
          controller.handleAppState(appState);
          // Style controls show only for a selection; see .canvas[data-selection] in styles.css.
          const selected = Object.keys(appState.selectedElementIds).length > 0;
          if (ref.current && (ref.current.dataset.selection === 'true') !== selected) ref.current.dataset.selection = String(selected);
        }}
        UIOptions={{ canvasActions: { loadScene: false, export: false, saveToActiveFile: false, toggleTheme: false } }}
      />
      {api && ref.current && <FrameTool api={api} root={ref.current} />}
    </div>
  );
}
