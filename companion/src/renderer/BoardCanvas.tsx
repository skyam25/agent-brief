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
    const container = () => ref.current?.querySelector<HTMLElement>('.excalidraw');
    const focusCanvas = () => {
      if (active.current && !editable(document.activeElement)) container()?.focus();
    };
    window.addEventListener('focus', focusCanvas);

    // Cmd+A selects the board, not the panel's text, while focus sits on a control outside it.
    const onKeyDown = (e: KeyboardEvent) => {
      const focused = document.activeElement;
      if (!active.current || !e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'a') return;
      if (editable(focused) || ref.current?.contains(focused)) return;
      const canvas = container();
      if (!canvas) return;
      e.preventDefault();
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, metaKey: true, bubbles: true, cancelable: true }));
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });

    // Excalidraw takes a paste only with focus inside it and its last known pointer over the canvas.
    // While the board shows, any paste outside a text field is the board's, so this sets both up first.
    let pointer: { x: number; y: number } | undefined;
    const onPointerMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
    };
    const aimAtCanvas = () => {
      container()?.focus();
      if (pointer && document.elementFromPoint(pointer.x, pointer.y) instanceof HTMLCanvasElement) return;
      const box = ref.current?.querySelector('canvas.interactive')?.getBoundingClientRect();
      if (!box) return;
      const centre = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      document.dispatchEvent(new PointerEvent('pointermove', { ...centre, pointerType: 'mouse', bubbles: true }));
    };

    // Excalidraw inserts pasted images before its onPaste callback runs, so this listens to the event itself.
    // A Stack board takes image pastes and drops itself: Excalidraw keeps only the first file and places it at the pointer.
    const onPaste = (e: ClipboardEvent) => {
      const focused = document.activeElement;
      const onBoard = active.current && !editable(focused);
      const files = imageFiles(e.clipboardData?.files);
      if (onBoard && controller.layout === 'stack' && files.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void controller.addScreenshots(files);
        return;
      }
      if (onBoard) aimAtCanvas();
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
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    document.addEventListener('paste', onPaste, { capture: true });
    ref.current?.addEventListener('drop', onDrop, { capture: true });
    const root = ref.current;
    return () => {
      pen.dispose();
      window.removeEventListener('focus', focusCanvas);
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      document.removeEventListener('pointermove', onPointerMove, { capture: true });
      document.removeEventListener('paste', onPaste, { capture: true });
      root?.removeEventListener('drop', onDrop, { capture: true });
    };
  }, [controller]);

  // Coming back from another view hands focus to the board.
  useEffect(() => {
    if (props.active && controller.api && !editable(document.activeElement)) {
      ref.current?.querySelector<HTMLElement>('.excalidraw')?.focus();
    }
  }, [props.active, controller]);

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
