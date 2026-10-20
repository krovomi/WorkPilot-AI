import { X } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
	BaseEdge,
	EdgeLabelRenderer,
	type EdgeProps,
	getSmoothStepPath,
} from "reactflow";

export interface DefaultEdgeData {
	label?: string;
	onEdgeLabelChange?: (id: string, label: string) => void;
	onDelete?: (id: string) => void;
}

/**
 * A connection between two blocks, carrying its spoken relationship
 * ("HTTP / REST", "lit / écrit") straight into the generated spec.
 *
 * Two things were wrong here. The chip was painted with literal `#fff` and
 * `#a5b4fc`, so on any dark theme — the app's default — a white box sat on a
 * dark canvas. And the edit committed to `data.onEdgeLabelChange`, a callback
 * the canvas never supplied: you could type a label, blur, and watch it
 * revert. Both are fixed; the callbacks are now wired by the canvas.
 */
export const DefaultEdge: React.FC<EdgeProps<DefaultEdgeData>> = ({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	style,
	markerEnd,
	data,
	selected,
}) => {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(data?.label ?? "");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!editing) setDraft(data?.label ?? "");
	}, [data?.label, editing]);

	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);

	// Orthogonal routing reads as an architecture diagram; the bezier it
	// replaced crossed its own blocks as soon as two edges shared a target.
	const [edgePath, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		borderRadius: 8,
	});

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next !== (data?.label ?? "")) data?.onEdgeLabelChange?.(id, next);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// Same reason as the node: the canvas deletes the selection on Backspace.
		e.stopPropagation();
		if (e.key === "Enter") commit();
		if (e.key === "Escape") {
			setDraft(data?.label ?? "");
			setEditing(false);
		}
	};

	return (
		<>
			<BaseEdge
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					stroke: selected ? "var(--primary, #6366f1)" : "var(--border, #444)",
					strokeWidth: selected ? 2 : 1.5,
					...style,
				}}
			/>
			<EdgeLabelRenderer>
				<div
					className="nodrag nopan group absolute flex items-center gap-1"
					style={{
						transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
						pointerEvents: "all",
					}}
				>
					{editing ? (
						<input
							ref={inputRef}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onBlur={commit}
							onKeyDown={handleKeyDown}
							className="w-28 rounded border border-primary bg-background px-1 py-0.5 text-[11px] text-foreground outline-none"
							aria-label={data?.label ?? ""}
						/>
					) : (
						<button
							type="button"
							onDoubleClick={() => setEditing(true)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									setEditing(true);
								}
							}}
							className={`max-w-[160px] truncate rounded border bg-card px-1.5 py-0.5 text-[11px] leading-tight text-card-foreground shadow-sm transition-colors hover:border-primary ${
								selected ? "border-primary" : "border-border"
							} ${data?.label ? "" : "opacity-60"}`}
						>
							{data?.label || "—"}
						</button>
					)}
					{data?.onDelete ? (
						<button
							type="button"
							onClick={() => data.onDelete?.(id)}
							className="rounded-full border bg-card p-0.5 text-muted-foreground opacity-0 transition-opacity hover:border-destructive hover:text-destructive focus:opacity-100 group-hover:opacity-100"
						>
							<X className="h-2.5 w-2.5" />
						</button>
					) : null}
				</div>
			</EdgeLabelRenderer>
		</>
	);
};
