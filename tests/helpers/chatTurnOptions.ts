import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import type { Id } from '@/domain';
import { canvasChatKey } from '@/features/modules/canvas/chatStore';
import type { runChatTurn } from '@/features/modules/canvas/chatController';
import type { runSnapshotChatTurn } from '@/features/modules/canvas/snapshotChat';

/**
 * THE shared option builders for the canvas chat's two turn surfaces
 * (docs/17 row 385). `canvas-chat-changes`, `canvas-chat-details` and
 * `canvas-chat-turn-parity` each grew their own copy of these bodies; the
 * copies were byte-identical (the duplication tripwire blessed them as debt at
 * row 212's baseline) and a body change in ONE of them silently re-hashed the
 * group. They are ONE seam now, so a new required option is added once.
 *
 * The module id is passed as a GETTER, not a value: every caller REASSIGNS its
 * `world` object in `beforeEach`, so a captured object (or id) would pin the
 * empty fixture from collection time.
 */
export function previewOptionsFor(
  currentModuleId: () => Id,
  chatDocument: string,
): (overrides?: Partial<Parameters<typeof runSnapshotChatTurn>[0]>) => Parameters<
  typeof runSnapshotChatTurn
>[0] {
  return (overrides = {}) => ({
    moduleId: currentModuleId(),
    key: canvasChatKey(currentModuleId()),
    doc: chatDocument,
    modelSelection: null,
    turn: new AbortController(),
    ...overrides,
  });
}

export function editorOptionsFor(
  currentModuleId: () => Id,
  chatDocument: string,
): (
  overrides?: Partial<Omit<Parameters<typeof runChatTurn>[0], 'view'>> & { doc?: string },
) => Parameters<typeof runChatTurn>[0] & { destroy: () => void } {
  return (overrides = {}) => {
    const host = globalThis.document.createElement('div');
    globalThis.document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({ doc: overrides.doc ?? chatDocument }),
      parent: host,
    });
    return {
      moduleId: currentModuleId(),
      key: canvasChatKey(currentModuleId()),
      modelSelection: null,
      turn: new AbortController(),
      ...overrides,
      view,
      destroy: () => {
        view.destroy();
        host.remove();
      },
    };
  };
}
