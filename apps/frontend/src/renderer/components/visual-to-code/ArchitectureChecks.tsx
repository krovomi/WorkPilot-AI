import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Edge, Node } from "reactflow";
import type { Lang } from "../../lib/architecture-connections";
import { type Finding, lintArchitecture } from "../../lib/architecture-lint";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type Setter<T> = (update: (items: T[]) => T[]) => void;

interface ArchitectureChecksProps {
	nodes: Node[];
	edges: Edge[];
	lang: Lang;
	setNodes: Setter<Node>;
	setEdges: Setter<Edge>;
}

/**
 * The coherence of the whole diagram, in the canvas' status bar: a count of
 * what the architecture rules find (shared database, synchronous cycle,
 * client around the gateway, queue nobody reads, stacks that do not fit…)
 * and, on click, the list. Picking one selects the blocks and links it is
 * about, so the inspector opens on them.
 */
export function ArchitectureChecks({
	nodes,
	edges,
	lang,
	setNodes,
	setEdges,
}: ArchitectureChecksProps) {
	const { t } = useTranslation("visualProgramming");
	const findings = useMemo(
		() => lintArchitecture(nodes, edges, lang, (k) => t(k, k)),
		[nodes, edges, lang, t],
	);
	if (nodes.length === 0) return null;

	const warnings = findings.filter((f) => f.severity === "warning").length;
	const focus = (f: Finding) => {
		setNodes((ns) => ns.map((n) => ({ ...n, selected: f.nodeIds.includes(n.id) })));
		setEdges((es) => es.map((e) => ({ ...e, selected: f.edgeIds.includes(e.id) })));
	};

	if (findings.length === 0) {
		return (
			<span className="flex items-center gap-1 text-success">
				<CheckCircle2 className="h-3 w-3" />
				{t("checksNone", "Architecture cohérente")}
			</span>
		);
	}

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={`flex items-center gap-1 rounded px-1 hover:bg-muted ${
						warnings > 0 ? "text-warning" : "text-muted-foreground"
					}`}
				>
					{warnings > 0 ? (
						<AlertTriangle className="h-3 w-3" />
					) : (
						<Info className="h-3 w-3" />
					)}
					{t("checksCount", "Points d'attention : {{count}}", {
						count: findings.length,
					})}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" side="top" className="w-96 p-0">
				<p className="border-b px-3 py-2 text-xs font-semibold">
					{t("checksTitle", "Cohérence de l'architecture")}
				</p>
				<ul className="max-h-80 overflow-y-auto py-1">
					{findings.map((f) => (
						<li key={f.id}>
							<button
								type="button"
								onClick={() => focus(f)}
								className="flex w-full gap-2 px-3 py-1.5 text-left text-xs leading-snug hover:bg-muted"
							>
								{f.severity === "warning" ? (
									<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
								) : (
									<Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
								)}
								<span>{f.message}</span>
							</button>
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
