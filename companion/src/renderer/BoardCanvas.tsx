import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Theme } from '../shared/ipc';
import type { BoardController, LoadedScene } from './controller';
import { FrameTool } from './FrameTool';
import { installPen } from './pen';

/** The Excalidraw canvas with pen handling, trimmed to drawing: no main menu, library or help. */
export function BoardCanvas(props: {
  controller: BoardController;
  scene: LoadedScene;
  theme: Theme;
  onReady: (api: ExcalidrawImperativeAPI) => void;
}) {
  const { controller, onReady } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    const pen = installPen(() => ref.current);
    // Keyboard shortcuts such as Cmd+Z reach Excalidraw only when it holds focus.
    const focusCanvas = () => {
      if (document.activeElement === document.body) ref.current?.querySelector<HTMLElement>('.excalidraw')?.focus();
    };
    window.addEventListener('focus', focusCanvas);
    // Excalidraw inserts pasted images before its onPaste callback runs, so this listens to the event itself.
    const onPaste = () => controller.afterPaste();
    document.addEventListener('paste', onPaste, { capture: true });
    return () => {
      pen.dispose();
      window.removeEventListener('focus', focusCanvas);
      document.removeEventListener('paste', onPaste, { capture: true });
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
