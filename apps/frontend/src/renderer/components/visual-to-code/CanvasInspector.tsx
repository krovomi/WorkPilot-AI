import { ArrowRight, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Edge, Node } from "reactflow";
import { blockMeta, FRAMEWORKS_BY_TYPE } from "../../lib/architecture-blocks";
import { type NodeLook, resolveLook } from "../../lib/custom-bricks";
import type { EdgePatch } from "../DefaultEdge";
import { Input, NativeSelect, Textarea } from "../ui";
import { ColorSwatches } from "./ColorSwatches";

interface CanvasInspectorProps {
	node: Node<NodeLook> | null;
	/** The name of the brick the node is made from, while that brick exists. */
	brickName?: string;
	edge: Edge | null;
	/** Names of the edge's two blocks, source first. */
	edgeEnds: [string, string] | null;
	/** The sentence the canvas writes for the edge when the person has not. */
	defaultExplanation: string;
	onNodeChange: (id: string, patch: Partial<NodeLook>) => void;
	onDeleteNode: (id: string) => void;
	onEdgeChange: (id: string, patch: EdgePatch) => void;
	onDeleteEdge: (id: string) => void;
}

const LABEL = "mb-1 block text-2xs font-medium text-muted-foreground";

/**
 * The side panel of what is selected: a block (its name, the role written above
 * it, its stack, what it does) or a connection (its relation and the sentence
 * that explains it). The only place a block's stack can be changed after it is
 * created, and the roomy way to write a connection's explanation.
 */
export function CanvasInspector({
	node,
	brickName,
	edge,
	edgeEnds,
	defaultExplanation,
	onNodeChange,
	onDeleteNode,
	onEdgeChange,
	onDeleteEdge,
}: CanvasInspectorProps) {
	const { t } = useTranslation("visualProgramming");
	if (!node && !edge) return null;

	const header = (title: string, onDelete: () => void, deleteLabel: string) => (
		<div className="flex items-center justify-between">
			<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				{title}
			</span>
			<button
				type="button"
				onClick={onDelete}
				title={deleteLabel}
				aria-label={deleteLabel}
				className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
			>
				<Trash2 className="h-3.5 w-3.5" />
			</button>
		</div>
	);

	if (node) {
		const data = node.data ?? {};
		const look = resolveLook(data);
		const stacks = data.type ? (FRAMEWORKS_BY_TYPE[data.type] ?? []) : [];
		const typeLabel = data.type
			? t(blockMeta(data.type)?.labelKey ?? data.type)
			: t("untyped", "Bloc libre");
		return (
			<aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3">
				{header(
					t("inspector", "Bloc sélectionné"),
					() => onDeleteNode(node.id),
					t("deleteBlock", "Supprimer le bloc"),
				)}
				<div>
					<label htmlFor="inspector-name" className={LABEL}>
						{t("blockName", "Nom")}
					</label>
					<Input
						id="inspector-name"
						value={String(data.label ?? "")}
						onChange={(e) => onNodeChange(node.id, { label: e.target.value })}
						className="h-auto w-full px-2 py-1 text-xs"
					/>
				</div>
				<div>
					<label htmlFor="inspector-kicker" className={LABEL}>
						{t("blockKicker", "Rôle affiché")}
					</label>
					<Input
						id="inspector-kicker"
						value={String(data.kicker ?? "")}
						onChange={(e) =>
							onNodeChange(node.id, { kicker: e.target.value || undefined })
						}
						placeholder={typeLabel}
						disabled={Boolean(brickName)}
						className="h-auto w-full px-2 py-1 font-mono text-xs uppercase"
					/>
					<p className="mt-1 flex items-center gap-1.5 text-3xs text-muted-foreground">
						<span
							className="inline-block h-2 w-2 rounded-full"
							style={{ backgroundColor: look.accent }}
						/>
						{typeLabel}
					</p>
				</div>
				{brickName ? null : (
					<div>
						<span className={LABEL}>{t("blockColor", "Couleur")}</span>
						<ColorSwatches
							value={data.accent}
							onChange={(accent) => onNodeChange(node.id, { accent })}
							label={t("blockColor", "Couleur")}
							fallback={look.accent}
							allowAuto
						/>
					</div>
				)}
				<div>
					<label htmlFor="inspector-stack" className={LABEL}>
						{t("blockStack", "Technologie")}
					</label>
					{stacks.length > 0 ? (
						<NativeSelect
							id="inspector-stack"
							value={String(data.framework ?? "")}
							onChange={(e) =>
								onNodeChange(node.id, { framework: e.target.value })
							}
							className="h-auto w-full px-2 py-1 text-xs"
						>
							<option value="">{t("noStack", "Non précisée")}</option>
							{stacks.map((fw) => (
								<option key={fw} value={fw}>
									{t(fw, fw)}
								</option>
							))}
						</NativeSelect>
					) : (
						<Input
							id="inspector-stack"
							value={String(data.framework ?? "")}
							onChange={(e) =>
								onNodeChange(node.id, { framework: e.target.value })
							}
							placeholder={t("otherStackPlaceholder", "ex. Quarkus")}
							className="h-auto w-full px-2 py-1 text-xs"
						/>
					)}
				</div>
				<div>
					<label htmlFor="inspector-description" className={LABEL}>
						{t("blockDescription", "Ce que fait ce bloc")}
					</label>
					<Textarea
						id="inspector-description"
						value={String(data.description ?? "")}
						onChange={(e) =>
							onNodeChange(node.id, {
								description: e.target.value || undefined,
							})
						}
						rows={3}
						disabled={Boolean(brickName)}
						placeholder={t(
							"blockDescriptionHint",
							"Facultatif : précisé à l'agent dans la spécification.",
						)}
						className="text-xs"
					/>
				</div>
				{brickName ? (
					<p className="text-3xs leading-snug text-muted-foreground">
						{t(
							"blockFromBrick",
							"Rôle, couleur et description viennent de la brique « {{name}} » : modifiez-la depuis la palette.",
							{ name: brickName },
						)}
					</p>
				) : null}
				<p className="mt-auto text-3xs leading-snug text-muted-foreground">
					{t(
						"inspectorHint",
						"Double-cliquez un bloc pour le renommer sur le canvas, ou une connexion pour changer son libellé.",
					)}
				</p>
			</aside>
		);
	}

	if (!edge) return null;
	const description = (edge.data?.description as string | undefined) ?? "";
	return (
		<aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3">
			{header(
				t("edgeInspector", "Interaction"),
				() => onDeleteEdge(edge.id),
				t("deleteConnection", "Supprimer la connexion"),
			)}
			{edgeEnds ? (
				<p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
					<span className="truncate">{edgeEnds[0]}</span>
					<ArrowRight className="h-3 w-3 shrink-0 text-primary" />
					<span className="truncate">{edgeEnds[1]}</span>
				</p>
			) : null}
			<div>
				<label htmlFor="inspector-relation" className={LABEL}>
					{t("edgeRelation", "Relation")}
				</label>
				<Input
					id="inspector-relation"
					value={String(edge.data?.label ?? "")}
					onChange={(e) => onEdgeChange(edge.id, { label: e.target.value })}
					placeholder={t("edgeRelationPlaceholder", "ex. HTTP / REST")}
					className="h-auto w-full px-2 py-1 font-mono text-xs uppercase"
				/>
			</div>
			<div>
				<span className={LABEL}>{t("edgeColor", "Couleur du connecteur")}</span>
				<ColorSwatches
					value={edge.data?.color as string | undefined}
					onChange={(color) => onEdgeChange(edge.id, { color: color ?? null })}
					label={t("edgeColor", "Couleur du connecteur")}
					allowAuto
				/>
			</div>
			<div>
				<div className="mb-1 flex items-center justify-between">
					<label htmlFor="inspector-explanation" className="text-2xs font-medium text-muted-foreground">
						{t("edgeExplanation", "Explication")}
					</label>
					{description ? (
						<button
							type="button"
							onClick={() => onEdgeChange(edge.id, { description: null })}
							className="flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground"
						>
							<RotateCcw className="h-2.5 w-2.5" />
							{t("edgeResetText", "Revenir au texte automatique")}
						</button>
					) : null}
				</div>
				<Textarea
					id="inspector-explanation"
					value={description}
					onChange={(e) =>
						onEdgeChange(edge.id, { description: e.target.value || null })
					}
					rows={4}
					placeholder={defaultExplanation}
					className="text-xs"
				/>
				<p className="mt-1 text-3xs leading-snug text-muted-foreground">
					{description
						? t("edgeOwnText", "Votre texte, gardé tel quel.")
						: t(
								"edgeAutoText",
								"Texte automatique, réécrit si vous renommez un bloc. Écrivez le vôtre pour le remplacer.",
							)}
				</p>
			</div>
		</aside>
	);
}
