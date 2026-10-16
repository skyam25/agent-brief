/** The right-click menu on a numbered list, as in Notion. It sets the format of that one list. */

import { ContextMenu } from '../ContextMenu';
import { CheckIcon } from '../Icons';
import { LIST_FORMATS, type ListFormat } from './lists';

export function ListFormatMenu(props: { x: number; y: number; current: ListFormat; onPick: (format: ListFormat) => void; onClose: () => void }) {
  return (
    <ContextMenu x={props.x} y={props.y} label="List format" testId="list-format-menu" onClose={props.onClose}>
      <h4>List format</h4>
      {LIST_FORMATS.map(({ format, label, sample }) => (
        <button
          key={format}
          type="button"
          className="ghost"
          role="menuitemradio"
          aria-checked={props.current === format}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(format)}
          data-testid="list-format"
          data-format={format}
        >
          <span className="list-format-sample" aria-hidden="true">
            {sample}
          </span>
          <span className="label-text">{label}</span>
          {props.current === format && <CheckIcon />}
        </button>
      ))}
    </ContextMenu>
  );
}
