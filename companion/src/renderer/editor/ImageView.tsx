/** A picture in the draft. Its source `att:<id>` resolves through the draft's attachments. */

import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { createContext, useContext } from 'react';
import { TrashIcon } from '../Icons';

export const ATT = 'att:';

export const AttachmentsContext = createContext<Record<string, string>>({});

function ImageView(props: ReactNodeViewProps) {
  const attachments = useContext(AttachmentsContext);
  const src = String(props.node.attrs.src ?? '');
  const alt = String(props.node.attrs.alt ?? '');
  const shown = src.startsWith(ATT) ? attachments[src.slice(ATT.length)] : /^https?:/.test(src) ? src : undefined;
  const editable = props.editor.isEditable;
  return (
    <NodeViewWrapper className="rich-image" data-selected={props.selected || undefined} data-testid="draft-image" data-drag-handle>
      {shown ? (
        <img src={shown} alt={alt} draggable={false} />
      ) : (
        <div className="missing muted" role="img" aria-label="Missing picture">
          Missing picture
        </div>
      )}
      {props.selected && editable && (
        <button type="button" className="image-delete" aria-label="Remove picture" title="Remove picture" onClick={props.deleteNode} data-testid="draft-image-delete">
          <TrashIcon />
        </button>
      )}
      {editable && (props.selected || alt) && (
        <input
          className="image-caption"
          type="text"
          placeholder="Add a caption"
          aria-label="Caption"
          value={alt}
          onChange={(e) => props.updateAttributes({ alt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const pos = props.getPos();
            if (typeof pos === 'number') props.editor.commands.focus(Math.min(pos + props.node.nodeSize + 1, props.editor.state.doc.content.size));
          }}
          data-testid="draft-image-caption"
        />
      )}
    </NodeViewWrapper>
  );
}

/** A block picture with a React view. */
export const Picture = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
}).configure({ inline: false, allowBase64: false });
