import { RotateCcw, X } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	BaseEdge,
	EdgeLabelRenderer,
	type EdgeProps,
	getBezierPath,
} from "reactflow";
import { isAccent } from "../lib/custom-bricks";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

/** What an edit of a connection changes; `description: null` returns it to the automatic text. */
export interface EdgePatch {
	label?: string;
	description?: string | null;
	/** `null` returns the wire to the canvas' connector colour. */
	color?: string | null;
}

export interface DefaultEdgeData {
	/** The short relation ("HTTP / REST"), written above the sentence. */
	label?: string;
	/** The sentence the person wrote. Absent: the canvas writes one. */
	description?: string;
	/** This wire's own colour (`#rrggbb`). Absent: the canvas' connectors. */
	color?: string;
	/** Linked although the architecture rules do not foresee it: drawn dashed. */
	forced?: boolean;
	/** Render-only: the sentence shown, theirs or the canvas'. */
	explanation?: string;
	/** Render-only: the sentence the canvas would write. */
	defaultExplanation?: string;
	/** Render-only: whether the sentences are shown on the canvas. */
	showText?: boolean;
	onEdgeChange?: (id: string, patch: EdgePatch) => void;
	onDelete?: (id: string) => void;
}

/**
 * A connection between two blocks: a glowing wire with light running along it
 * in the direction of the interaction, and, at its middle, what the
 * interaction is — the relation in small capitals, then a sentence saying
 * what the source does with the target.
 *
 * The sentence is written by the canvas from the two blocks until the person
 * writes their own (double-click the label). Theirs is kept as typed; clearing
 * it, or the reset button, returns to the automatic one. Both reach the build
 * spec, one line per connection.
 */
export const DefaultEdge: React.FC<EdgeProps<DefaultEdgeData>> = ({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
	selected,
}) => {
	const { t } = useTranslation("visualProgramming");
	const [editing, setEditing] = useState(false);
	const [draftLabel, setDraftLabel] = useState(data?.label ?? "");
	const [draftText, setDraftText] = useState(data?.explanation ?? "");
	const labelRef = useRef<HTMLInputElement>(null);
	const formRef = useRef<HTMLFormElement>(null);

	useEffect(() => {
		if (editing) return;
		setDraftLabel(data?.label ?? "");
		setDraftText(data?.explanation ?? "");
	}, [data?.label, data?.explanation, editing]);

	useEffect(() => {
		if (editing) labelRef.current?.focus();
	}, [editing]);

	// A curve, not a staircase: the wires of a node graph flow from one card to
	// the next, and the eye follows a curve to its end where it loses a corner.
	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		curvature: 0.35,
	});

	const commit = () => {
		setEditing(false);
		const label = draftLabel.trim();
		const text = draftText.trim();
		const patch: EdgePatch = {};
		if (label !== (data?.label ?? "")) patch.label = label;
		// Their own words only when they differ from what the canvas writes:
		// keeping the automatic sentence as typed text would freeze it, and a
		// renamed block would no longer be named in it.
		const own = text && text !== data?.defaultExplanation ? text : null;
		if (own !== (data?.description ?? null)) patch.description = own;
		if (Object.keys(patch).length > 0) data?.onEdgeChange?.(id, patch);
	};

	const cancel = () => {
		setDraftLabel(data?.label ?? "");
		setDraftText(data?.explanation ?? "");
		setEditing(false);
	};

	/** Leaving the editor saves it; moving between its two fields does not. */
	const handleBlur = (e: React.FocusEvent) => {
		if (!formRef.current?.contains(e.relatedTarget as Node | null)) commit();
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// The canvas deletes the selection on Delete/Backspace.
		e.stopPropagation();
		if (e.key === "Escape") cancel();
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			commit();
		}
	};

	const showText = data?.showText !== false;
	// Its own colour, recomputed on the wire (`.vtc-tint`) so its bright core
	// and the light running on it follow.
	const tint = isAccent(data?.color)
		? ({ "--vtc-flow": data.color } as React.CSSProperties)
		: undefined;
	const custom = Boolean(data?.description);

	return (
		<>
			<g className="vtc-tint" style={tint}>
				<path d={edgePath} className="vtc-edge-glow" />
				<BaseEdge
					path={edgePath}
					interactionWidth={18}
					style={{ stroke: "transparent" }}
				/>
				<path
					d={edgePath}
					className="vtc-edge-core"
					style={data?.forced ? { strokeDasharray: "6 5" } : undefined}
				/>
				<path d={edgePath} className="vtc-edge-spark" />
			</g>
			<EdgeLabelRenderer>
				<div
					className="vtc-tint nodrag nopan group absolute"
					style={{
						...tint,
						// The tag sits on the wire and the sentence hangs below it, off the line.
						transform: `translate(-50%, -9px) translate(${labelX}px, ${labelY}px)`,
						pointerEvents: "all",
					}}
				>
					{editing ? (
						<form
							ref={formRef}
							className="vtc-edge-editor flex w-60 flex-col gap-1.5"
							onSubmit={(e) => {
								e.preventDefault();
								commit();
							}}
						>
							<Input
								ref={labelRef}
								value={draftLabel}
								onChange={(e) => setDraftLabel(e.target.value)}
								onBlur={handleBlur}
								onKeyDown={handleKeyDown}
								placeholder={t("edgeRelationPlaceholder", "ex. HTTP / REST")}
								aria-label={t("edgeRelation", "Relation")}
								className="h-auto px-1.5 py-0.5 font-mono text-3xs uppercase"
							/>
							<Textarea
								value={draftText}
								onChange={(e) => setDraftText(e.target.value)}
								onBlur={handleBlur}
								onKeyDown={handleKeyDown}
								rows={3}
								placeholder={data?.defaultExplanation}
								aria-label={t("edgeExplanation", "Explication")}
								className="min-h-0 resize-none px-1.5 py-1 text-2xs leading-snug"
							/>
							<span className="vtc-muted text-3xs">
								{t("edgeEditHint", "Entrée pour valider, Échap pour annuler.")}
							</span>
						</form>
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
							title={t("edgeEditTooltip", "Double-cliquez pour modifier l'interaction")}
							className="vtc-edge-label"
							data-selected={selected ? "true" : "false"}
						>
							<span className="vtc-kicker vtc-edge-tag truncate">
								{data?.label || t("edgeNoRelation", "Interaction")}
							</span>
							{showText && data?.explanation ? (
								<span className="vtc-edge-text mt-0.5">{data.explanation}</span>
							) : null}
						</button>
					)}
					{!editing ? (
						<div className="absolute -top-2 -right-2 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
							{custom ? (
								<button
									type="button"
									onClick={() => data?.onEdgeChange?.(id, { description: null })}
									title={t("edgeResetText", "Revenir au texte automatique")}
									aria-label={t("edgeResetText", "Revenir au texte automatique")}
									className="vtc-chip"
								>
									<RotateCcw className="h-2.5 w-2.5" />
								</button>
							) : null}
							{data?.onDelete ? (
								<button
									type="button"
									onClick={() => data.onDelete?.(id)}
									title={t("deleteConnection", "Supprimer la connexion")}
									aria-label={t("deleteConnection", "Supprimer la connexion")}
									className="vtc-chip hover:text-destructive"
								>
									<X className="h-2.5 w-2.5" />
								</button>
							) : null}
						</div>
					) : null}
				</div>
			</EdgeLabelRenderer>
		</>
	);
};
