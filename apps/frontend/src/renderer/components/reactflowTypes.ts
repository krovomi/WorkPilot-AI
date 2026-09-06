import { DefaultEdge } from "./DefaultEdge";
import { EditableNode } from "./EditableNode";

// `EditableNodeWrapper` used to sit between ReactFlow and `EditableNode`,
// holding its own copy of the label. That copy was the bug: a rename updated
// the wrapper's state and returned, so the canvas — and therefore the
// generated spec, the export and the store — kept the old name while the
// screen showed the new one. The node now reads the label straight from
// `data` and pushes edits back through `onRename`, leaving one owner.
export const nodeTypes = { editable: EditableNode };
export const edgeTypes = { default: DefaultEdge };
