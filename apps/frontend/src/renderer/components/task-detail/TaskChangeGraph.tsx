import { saveAs } from "file-saver";
import {
	AlertTriangle,
	ArrowLeft,
	Download,
	GitBranch,
	Loader2,
	RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactFlow, {
	Background,
	BackgroundVariant,
	Controls,
	type Edge,
	Handle,
	MarkerType,
	type Node,
	type NodeProps,
	Position,
	type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import type { Task, WorktreeDiffFile } from "../../../shared/types";
import {
	buildChangeGraph,
	type ChangeEdge,
	type ChangeGraph,
	type ChangeGraphTranslate,
	type ChangeLayer,
	type ChangeNode,
	type ChangeStatus,
	describeEdge,
	describeNode,
	describeSubject,
	toGraphifyNodeLink,
} from "../../../shared/utils/change-graph";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

export interface TaskChangeGraphProps {
	readonly task: Task;
}

type Selection = { type: "node" | "edge"; id: string } | null;

type LoadState =
	| { phase: "loading" }
	| { phase: "ready"; files: WorktreeDiffFile[] }
	| { phase: "unavailable" }
	| { phase: "error"; message: string };

const NODE_WIDTH = 220;
const NODE_HEIGHT = 74;
const COLUMN_GAP = 90;
const ROW_GAP = 26;
const LANE_HEADER = 44;
const LANE_PADDING = 16;

const STATUS_STYLES: Record<ChangeStatus, string> = {
	added: "border-emerald-500/70 bg-emerald-500/10",
	modified: "border-amber-500/70 bg-amber-500/10",
	deleted: "border-red-500/70 bg-red-500/10 opacity-80",
};

const STATUS_DOT: Record<ChangeStatus, string> = {
	added: "bg-emerald-500",
	modified: "bg-amber-500",
	deleted: "bg-red-500",
};

interface ChangeNodeData {
	node: ChangeNode;
	subject: string;
	statusLabel: string;
	dimmed: boolean;
	selected: boolean;
}

interface LaneData {
	label: string;
}

/**
 * Un nœud du graphe : le nom, ce que c'est, et ce qui lui est arrivé.
 * Les arêtes partent de la gauche (vers le cœur) et arrivent à droite, parce
 * que les couches sont rangées du Domain vers l'extérieur.
 */
function ChangeNodeCard({ data }: NodeProps<ChangeNodeData>) {
	const { node } = data;
	return (
		<div
			className={cn(
				"rounded-md border-2 px-3 py-2 text-left shadow-sm transition-opacity bg-card",
				STATUS_STYLES[node.status],
				data.dimmed && "opacity-30",
				data.selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
			)}
			style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
		>
			<Handle type="target" position={Position.Right} className="!bg-muted-foreground" />
			<Handle type="source" position={Position.Left} className="!bg-muted-foreground" />
			<div className="flex items-center gap-1.5">
				<span
					className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[node.status])}
					aria-hidden
				/>
				<span className="truncate font-mono text-xs font-semibold text-foreground">
					{node.name}
				</span>
			</div>
			<div className="mt-0.5 truncate text-[11px] text-muted-foreground">
				{data.subject}
			</div>
			<div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
				<span>{data.statusLabel}</span>
				<span className="text-emerald-600 dark:text-emerald-400">+{node.additions}</span>
				<span className="text-red-600 dark:text-red-400">−{node.deletions}</span>
				{node.members.length > 0 && <span>· {node.members.length} ◆</span>}
			</div>
		</div>
	);
}

/** La colonne d'une couche : un fond et un titre, jamais sélectionnable. */
function LaneNode({ data }: NodeProps<LaneData>) {
	return (
		<div className="h-full w-full rounded-lg border border-dashed border-border bg-muted/30">
			<div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				{data.label}
			</div>
		</div>
	);
}

const NODE_TYPES = { change: ChangeNodeCard, lane: LaneNode };

/**
 * Le chemin de la tâche, dessiné : ce qu'elle a créé, modifié ou supprimé,
 * couche par couche, et les liens que le code porte entre ces éléments.
 *
 * Tout vient du diff du worktree et du plan — aucun modèle n'est appelé, si
 * bien que l'onglet répond dès qu'un diff existe et ne peut pas décrire une
 * relation que le code ne contient pas (`shared/utils/change-graph.ts`).
 */
export function TaskChangeGraph({ task }: TaskChangeGraphProps) {
	const { t } = useTranslation(["tasks"]);
	const translate = t as unknown as ChangeGraphTranslate;
	const [state, setState] = useState<LoadState>({ phase: "loading" });
	const [selection, setSelection] = useState<Selection>(null);
	const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	// Le diff est relu à chaque ouverture de l'onglet (le panneau est démonté
	// quand on le quitte) : une tâche en cours de codage change entre deux.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken est le bouton « Relire le diff »
	useEffect(() => {
		let cancelled = false;
		setState({ phase: "loading" });
		globalThis.electronAPI
			.getWorktreeDiff(task.id)
			.then((result) => {
				if (cancelled) return;
				if (!result.success || !result.data) {
					setState({ phase: "unavailable" });
					return;
				}
				setState({ phase: "ready", files: result.data.files ?? [] });
			})
			.catch((failure: unknown) => {
				if (cancelled) return;
				setState({
					phase: "error",
					message: failure instanceof Error ? failure.message : String(failure),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [task.id, reloadToken]);

	const graph = useMemo<ChangeGraph | null>(() => {
		if (state.phase !== "ready") return null;
		return buildChangeGraph(state.files, task.subtasks ?? []);
	}, [state, task.subtasks]);

	const nodesById = useMemo(
		() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
		[graph],
	);

	const flowElements = useMemo(
		() => (graph ? layout(graph, selection, translate) : { nodes: [], edges: [] }),
		[graph, selection, translate],
	);

	const select = useCallback(
		(next: Selection) => {
			setSelection(next);
			if (!next || !flow || !graph) return;
			const ids =
				next.type === "node"
					? [next.id]
					: graph.edges
							.filter((e) => e.id === next.id)
							.flatMap((e) => [e.source, e.target]);
			if (ids.length > 0) {
				flow.fitView({
					nodes: ids.map((id) => ({ id })),
					duration: 400,
					padding: 0.6,
					maxZoom: 1.2,
				});
			}
		},
		[flow, graph],
	);

	const handleExport = useCallback(() => {
		if (!graph) return;
		const document = toGraphifyNodeLink(graph, {
			taskId: task.id,
			specId: task.specId,
			describe: translate,
		});
		saveAs(
			new Blob([`${JSON.stringify(document, null, 2)}\n`], {
				type: "application/json",
			}),
			`${task.specId || task.id}-change-graph.json`,
		);
	}, [graph, task.id, task.specId, translate]);

	if (state.phase === "loading") {
		return (
			<CenteredMessage>
				<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
				{t("tasks:changeGraph.loading")}
			</CenteredMessage>
		);
	}
	if (state.phase === "unavailable") {
		return <CenteredMessage>{t("tasks:changeGraph.noDiff")}</CenteredMessage>;
	}
	if (state.phase === "error") {
		return (
			<CenteredMessage tone="error">
				<AlertTriangle className="h-4 w-4" aria-hidden />
				{t("tasks:changeGraph.error", { error: state.message })}
			</CenteredMessage>
		);
	}
	if (!graph || graph.nodes.length === 0) {
		return <CenteredMessage>{t("tasks:changeGraph.empty")}</CenteredMessage>;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
				<GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium">{t("tasks:changeGraph.title")}</div>
					<div className="text-xs text-muted-foreground">
						{t("tasks:changeGraph.description")}
					</div>
				</div>
				<div className="flex items-center gap-3 text-xs text-muted-foreground">
					{(["added", "modified", "deleted"] as const).map((status) => (
						<span key={status} className="flex items-center gap-1">
							<span className={cn("h-2 w-2 rounded-full", STATUS_DOT[status])} aria-hidden />
							{t(`tasks:changeGraph.legend.${status}`)}
						</span>
					))}
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={() => setReloadToken((n) => n + 1)}
					aria-label={t("tasks:changeGraph.actions.refresh")}
					title={t("tasks:changeGraph.actions.refresh")}
				>
					<RefreshCw className="h-3.5 w-3.5" aria-hidden />
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={handleExport}
					title={t("tasks:changeGraph.actions.exportHint")}
				>
					<Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
					{t("tasks:changeGraph.actions.export")}
				</Button>
			</div>

			<div className="flex min-h-0 flex-1">
				<div className="relative min-w-0 flex-1" data-testid="change-graph-canvas">
					<ReactFlow
						nodes={flowElements.nodes}
						edges={flowElements.edges}
						nodeTypes={NODE_TYPES}
						onInit={setFlow}
						onNodeClick={(_, node) => {
							if (node.type === "change") select({ type: "node", id: node.id });
						}}
						onEdgeClick={(_, edge) => select({ type: "edge", id: edge.id })}
						onPaneClick={() => setSelection(null)}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable
						fitView
						fitViewOptions={{ padding: 0.15 }}
						minZoom={0.2}
						proOptions={{ hideAttribution: true }}
					>
						<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
						<Controls showInteractive={false} />
					</ReactFlow>
				</div>

				<aside className="flex w-[22rem] shrink-0 flex-col border-l border-border">
					<ScrollArea className="flex-1">
						<div className="space-y-4 p-4">
							{selection ? (
								<SelectionDetails
									selection={selection}
									graph={graph}
									nodesById={nodesById}
									task={task}
									translate={translate}
									onSelect={select}
								/>
							) : (
								<Story graph={graph} translate={translate} onSelect={select} />
							)}
							<Footnotes graph={graph} />
						</div>
					</ScrollArea>
				</aside>
			</div>
		</div>
	);
}

function CenteredMessage({
	children,
	tone,
}: {
	children: ReactNode;
	tone?: "error";
}) {
	return (
		<div
			className={cn(
				"flex h-full items-center justify-center gap-2 p-6 text-center text-sm",
				tone === "error" ? "text-destructive" : "text-muted-foreground",
			)}
		>
			{children}
		</div>
	);
}

/** Le récit : une phrase par élément, dans l'ordre où la fonctionnalité se construit. */
function Story({
	graph,
	translate,
	onSelect,
}: {
	graph: ChangeGraph;
	translate: ChangeGraphTranslate;
	onSelect: (selection: Selection) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
	return (
		<section>
			<h3 className="text-sm font-semibold">{t("tasks:changeGraph.story.title")}</h3>
			<p className="mb-3 text-xs text-muted-foreground">
				{t("tasks:changeGraph.story.hint")}
			</p>
			<ol className="space-y-3">
				{graph.layers.map((layer) => (
					<li key={layer}>
						<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							{t(`tasks:changeGraph.layers.${layer}.name`)}
						</div>
						<ul className="space-y-1.5">
							{graph.nodes
								.filter((node) => node.layer === layer)
								.map((node) => (
									<li key={node.id}>
										<button
											type="button"
											onClick={() => onSelect({ type: "node", id: node.id })}
											className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
										>
											<span
												className={cn(
													"mt-1.5 h-2 w-2 shrink-0 rounded-full",
													STATUS_DOT[node.status],
												)}
												aria-hidden
											/>
											<span>{describeNode(node, translate)}</span>
										</button>
										{graph.edges
											.filter((edge) => edge.source === node.id)
											.map((edge) => (
												<button
													key={edge.id}
													type="button"
													onClick={() => onSelect({ type: "edge", id: edge.id })}
													className="ml-6 block w-[calc(100%-1.5rem)] rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
												>
													↳ {describeEdge(edge, nodesById, translate)}
												</button>
											))}
									</li>
								))}
						</ul>
					</li>
				))}
			</ol>
		</section>
	);
}

function SelectionDetails({
	selection,
	graph,
	nodesById,
	task,
	translate,
	onSelect,
}: {
	selection: NonNullable<Selection>;
	graph: ChangeGraph;
	nodesById: ReadonlyMap<string, ChangeNode>;
	task: Task;
	translate: ChangeGraphTranslate;
	onSelect: (selection: Selection) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const back = (
		<Button
			size="sm"
			variant="ghost"
			className="-ml-2 h-7 px-2 text-xs"
			onClick={() => onSelect(null)}
		>
			<ArrowLeft className="mr-1 h-3.5 w-3.5" aria-hidden />
			{t("tasks:changeGraph.story.title")}
		</Button>
	);

	if (selection.type === "edge") {
		const edge = graph.edges.find((e) => e.id === selection.id);
		if (!edge) return back;
		const from = nodesById.get(edge.source);
		const to = nodesById.get(edge.target);
		return (
			<section className="space-y-3" data-testid="change-graph-edge-details">
				{back}
				<Badge variant="outline">{t(`tasks:changeGraph.relations.${edge.relation}`)}</Badge>
				<p className="text-sm leading-relaxed">
					{describeEdge(edge, nodesById, translate)}
				</p>
				<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<span className="text-muted-foreground">{t("tasks:changeGraph.panel.from")}</span>
					{from && <NodeLink node={from} translate={translate} onSelect={onSelect} />}
					<span className="text-muted-foreground">{t("tasks:changeGraph.panel.to")}</span>
					{to && <NodeLink node={to} translate={translate} onSelect={onSelect} />}
				</div>
				<div>
					<div className="mb-1 text-xs font-medium text-muted-foreground">
						{t("tasks:changeGraph.panel.evidence")}
					</div>
					{edge.evidence ? (
						<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[11px]">
							{edge.evidence}
						</pre>
					) : (
						<p className="text-xs italic text-muted-foreground">
							{t("tasks:changeGraph.panel.noEvidence")}
						</p>
					)}
				</div>
			</section>
		);
	}

	const node = nodesById.get(selection.id);
	if (!node) return back;
	const outgoing = graph.edges.filter((e) => e.source === node.id);
	const incoming = graph.edges.filter((e) => e.target === node.id);
	const subtasks = (task.subtasks ?? []).filter((s) => node.subtaskIds.includes(s.id));

	return (
		<section className="space-y-3" data-testid="change-graph-node-details">
			{back}
			<div className="flex items-center gap-2">
				<span className={cn("h-2.5 w-2.5 rounded-full", STATUS_DOT[node.status])} aria-hidden />
				<span className="font-mono text-sm font-semibold">{node.name}</span>
				<Badge variant="outline">{t(`tasks:changeGraph.legend.${node.status}`)}</Badge>
			</div>
			<p className="text-sm leading-relaxed">{describeNode(node, translate)}</p>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
				<dt className="text-muted-foreground">{t("tasks:changeGraph.panel.file")}</dt>
				<dd className="break-all font-mono">{node.file}</dd>
				<dt className="text-muted-foreground">{t("tasks:changeGraph.panel.layer")}</dt>
				<dd>{t(`tasks:changeGraph.layers.${node.layer}.name`)}</dd>
				<dt className="text-muted-foreground" />
				<dd>
					{t("tasks:changeGraph.panel.lines", {
						additions: node.additions,
						deletions: node.deletions,
					})}
				</dd>
			</dl>

			{node.members.length > 0 && (
				<DetailList title={t("tasks:changeGraph.panel.members")}>
					{node.members.map((member) => (
						<li key={`${member.kind}:${member.name}`} className="flex items-center gap-2">
							<span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[member.change])} aria-hidden />
							<span className="font-mono">{member.name}</span>
							<span className="text-muted-foreground">
								{t(`tasks:changeGraph.memberChange.${member.change}`)}
							</span>
						</li>
					))}
				</DetailList>
			)}

			{subtasks.length > 0 && (
				<DetailList title={t("tasks:changeGraph.panel.subtasks")}>
					{subtasks.map((subtask) => (
						<li key={subtask.id}>
							<div className="font-medium">{subtask.title || subtask.id}</div>
							{subtask.description && subtask.description !== subtask.title && (
								<div className="text-muted-foreground">{subtask.description}</div>
							)}
						</li>
					))}
				</DetailList>
			)}

			<EdgeList
				title={t("tasks:changeGraph.panel.outgoing")}
				edges={outgoing}
				nodesById={nodesById}
				translate={translate}
				onSelect={onSelect}
			/>
			<EdgeList
				title={t("tasks:changeGraph.panel.incoming")}
				edges={incoming}
				nodesById={nodesById}
				translate={translate}
				onSelect={onSelect}
			/>
		</section>
	);
}

function DetailList({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div>
			<div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
			<ul className="space-y-1 text-xs">{children}</ul>
		</div>
	);
}

function EdgeList({
	title,
	edges,
	nodesById,
	translate,
	onSelect,
}: {
	title: string;
	edges: ChangeEdge[];
	nodesById: ReadonlyMap<string, ChangeNode>;
	translate: ChangeGraphTranslate;
	onSelect: (selection: Selection) => void;
}) {
	if (edges.length === 0) return null;
	return (
		<DetailList title={title}>
			{edges.map((edge) => (
				<li key={edge.id}>
					<button
						type="button"
						onClick={() => onSelect({ type: "edge", id: edge.id })}
						className="w-full rounded px-1.5 py-1 text-left hover:bg-muted"
					>
						{describeEdge(edge, nodesById, translate)}
					</button>
				</li>
			))}
		</DetailList>
	);
}

function NodeLink({
	node,
	translate,
	onSelect,
}: {
	node: ChangeNode;
	translate: ChangeGraphTranslate;
	onSelect: (selection: Selection) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect({ type: "node", id: node.id })}
			className="text-left text-primary hover:underline"
		>
			{describeSubject(node, translate)}
		</button>
	);
}

function Footnotes({ graph }: { graph: ChangeGraph }) {
	const { t } = useTranslation(["tasks"]);
	if (graph.skippedFiles.length === 0 && graph.truncatedFiles.length === 0) return null;
	return (
		<div className="space-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
			{graph.truncatedFiles.length > 0 && (
				<p title={graph.truncatedFiles.join("\n")}>
					{t("tasks:changeGraph.truncated", { count: graph.truncatedFiles.length })}
				</p>
			)}
			{graph.skippedFiles.length > 0 && (
				<p title={graph.skippedFiles.join("\n")}>
					{t("tasks:changeGraph.skipped", { count: graph.skippedFiles.length })}
				</p>
			)}
		</div>
	);
}

/**
 * Une colonne par couche, du Domain vers l'extérieur, les nœuds empilés dans
 * l'ordre du récit. Une mise en page fixe plutôt qu'une simulation de forces :
 * la position d'un nœud *dit* sa couche, et elle ne bouge pas d'une ouverture
 * à l'autre.
 */
function layout(
	graph: ChangeGraph,
	selection: Selection,
	translate: ChangeGraphTranslate,
): { nodes: Node[]; edges: Edge[] } {
	const focus = focusSet(graph, selection);
	const columns = new Map<ChangeLayer, ChangeNode[]>();
	for (const layer of graph.layers) columns.set(layer, []);
	for (const node of graph.nodes) columns.get(node.layer)?.push(node);
	const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
	const laneHeight = LANE_HEADER + tallest * (NODE_HEIGHT + ROW_GAP) + LANE_PADDING;

	const nodes: Node[] = [];
	graph.layers.forEach((layer, column) => {
		const x = column * (NODE_WIDTH + COLUMN_GAP + LANE_PADDING * 2);
		nodes.push({
			id: `lane:${layer}`,
			type: "lane",
			position: { x, y: 0 },
			data: { label: translate(`tasks:changeGraph.layers.${layer}.name`) },
			style: { width: NODE_WIDTH + LANE_PADDING * 2, height: laneHeight },
			selectable: false,
			draggable: false,
			focusable: false,
			zIndex: -1,
		});
		(columns.get(layer) ?? []).forEach((node, row) => {
			nodes.push({
				id: node.id,
				type: "change",
				position: {
					x: x + LANE_PADDING,
					y: LANE_HEADER + row * (NODE_HEIGHT + ROW_GAP),
				},
				data: {
					node,
					subject: describeSubject(node, translate),
					statusLabel: translate(`tasks:changeGraph.legend.${node.status}`),
					dimmed: focus !== null && !focus.nodes.has(node.id),
					selected: selection?.type === "node" && selection.id === node.id,
				} satisfies ChangeNodeData,
			});
		});
	});

	const edges: Edge[] = graph.edges.map((edge) => {
		const active = focus === null || focus.edges.has(edge.id);
		const selected = selection?.type === "edge" && selection.id === edge.id;
		return {
			id: edge.id,
			source: edge.source,
			target: edge.target,
			type: "smoothstep",
			label: translate(`tasks:changeGraph.relations.${edge.relation}`),
			labelStyle: { fontSize: 10 },
			labelBgPadding: [4, 2] as [number, number],
			labelBgBorderRadius: 4,
			animated: edge.relation === "maps" || edge.sharedMembers.length > 0,
			markerEnd: { type: MarkerType.ArrowClosed },
			style: {
				strokeWidth: selected ? 3 : 1.5,
				opacity: active ? 1 : 0.15,
				strokeDasharray: edge.relation === "tests" ? "4 3" : undefined,
			},
			zIndex: selected ? 10 : 0,
		};
	});
	return { nodes, edges };
}

/** Ce qui reste net quand quelque chose est sélectionné : lui et ses voisins. */
function focusSet(
	graph: ChangeGraph,
	selection: Selection,
): { nodes: Set<string>; edges: Set<string> } | null {
	if (!selection) return null;
	const nodes = new Set<string>();
	const edges = new Set<string>();
	if (selection.type === "node") {
		nodes.add(selection.id);
		for (const edge of graph.edges) {
			if (edge.source === selection.id || edge.target === selection.id) {
				edges.add(edge.id);
				nodes.add(edge.source);
				nodes.add(edge.target);
			}
		}
	} else {
		const edge = graph.edges.find((e) => e.id === selection.id);
		if (edge) {
			edges.add(edge.id);
			nodes.add(edge.source);
			nodes.add(edge.target);
		}
	}
	return { nodes, edges };
}
