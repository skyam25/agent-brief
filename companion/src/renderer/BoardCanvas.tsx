import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef } from 'react';
import type { Theme } from '../shared/ipc';
import type { BoardController, LoadedScene } from './controller';
import { installPen } from './pen';

/** The Excalidraw canvas with pen handling. The Mac panel and the web client both use it. */
export function BoardCanvas(props: {
  controller: BoardController;
  scene: LoadedScene;
  theme: Theme;
  onReady: (api: ExcalidrawImperativeAPI) => void;
}) {
  const { controller, onReady } = props;
  const ref = useRef<HTMLDivElement>(null);

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
          appState: { ...props.scene.appState, activeTool: { type: 'freedraw' } as never },
          files: props.scene.files,
          scrollToContent: true,
        }}
        onChange={(elements) => controller.handleChange(elements)}
        UIOptions={{ canvasActions: { loadScene: false, export: false, saveToActiveFile: false, toggleTheme: false } }}
      />
    </div>
  );
}
