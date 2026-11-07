import { Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Handle, type NodeProps, Position } from "reactflow";
import { type NodeLook, resolveLook } from "../lib/custom-bricks";
import { Input } from "./ui/input";
import { FlowCard } from "./visual-to-code/FlowCard";

export interface EditableNodeData extends NodeLook {
	onRename?: (id: string, label: string) => void;
	onDelete?: (id: string) => void;
}

/**
 * A block on the canvas, drawn as a card: its role in small uppercase letters
 * and its colour above its name (`FlowCard`). The role is the block's palette
 * type, or the one its brick or the inspector gave it.
 *
 * Handles are Left (in) / Right (out) rather than Top / Bottom: the connection
 * rules encode a request direction, and a left-to-right diagram makes drawing
 * the arrow the wrong way visibly wrong. They show on hover, so a resting
 * graph is cards and wires only.
 */
export const EditableNode: React.FC<NodeProps<EditableNodeData>> = ({
	id,
	data,
	selected,
}) => {
	const { t } = useTranslation("visualProgramming");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(data.label ?? "");
	const inputRef = useRef<HTMLInputElement>(null);
	const look = resolveLook(data);

	// The label is owned by the canvas. Re-sync whenever it changes there —
	// undo, an import, or a rename from the inspector — so the node never shows
	// a value the diagram no longer holds.
	useEffect(() => {
		if (!editing) setDraft(data.label ?? "");
	}, [data.label, editing]);

	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		// An empty name would leave an anonymous box behind; keep the old one.
		if (next.length === 0) {
			setDraft(data.label ?? "");
			return;
		}
		if (next !== data.label) data.onRename?.(id, next);
	};

	const cancel = () => {
		setDraft(data.label ?? "");
		setEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// The canvas deletes the selection on Delete/Backspace. Without this the
		// node being renamed is destroyed by its own first correction keystroke.
		e.stopPropagation();
		if (e.key === "Enter") commit();
		if (e.key === "Escape") cancel();
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: double-click to rename is the canvas idiom
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: double-click to rename is the canvas idiom
		<div onDoubleClick={() => setEditing(true)} className="group relative">
			<Handle type="target" position={Position.Left} />
			<FlowCard
				look={look}
				kicker={look.kicker ?? t(look.kickerKey)}
				stack={data.framework ? t(data.framework, data.framework) : undefined}
				selected={selected}
				hint={data.description}
			>
				{editing ? (
					<Input
						ref={inputRef}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commit}
						onKeyDown={handleKeyDown}
						className="nodrag h-auto w-full px-1 py-0.5 text-base font-semibold"
						aria-label={String(data.label ?? "")}
					/>
				) : (
					<p className="truncate pr-4">{data.label}</p>
				)}
			</FlowCard>
			{data.onDelete ? (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						data.onDelete?.(id);
					}}
					title={t("deleteBlock", "Supprimer le bloc")}
					aria-label={t("deleteBlock", "Supprimer le bloc")}
					className="vtc-muted nodrag absolute right-2 bottom-2 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
				>
					<Trash2 className="h-3 w-3" />
				</button>
			) : null}
			<Handle type="source" position={Position.Right} />
		</div>
	);
};
