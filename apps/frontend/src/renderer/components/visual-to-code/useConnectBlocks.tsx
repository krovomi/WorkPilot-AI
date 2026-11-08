import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { addEdge, type Connection, type Edge, type Node } from "reactflow";
import { toast } from "@/hooks/use-toast";
import {
	connectionLabel,
	type EndInfo,
	type Lang,
	relationOptions,
} from "../../lib/architecture-connections";
import { connectionVerdict } from "../../lib/connection-verdicts";
import { stackWarnings } from "../../lib/stack-rules";
import { ToastAction } from "../ui/toast";

type SetEdges = (update: (edges: Edge[]) => Edge[]) => void;

function endInfo(node: Node | undefined): EndInfo {
	return {
		type: node?.data?.type as string | undefined,
		framework: node?.data?.framework as string | undefined,
	};
}

function ends(nodes: Node[], edge: Edge | null): [EndInfo, EndInfo] | null {
	if (!edge) return null;
	return [
		endInfo(nodes.find((n) => n.id === edge.source)),
		endInfo(nodes.find((n) => n.id === edge.target)),
	];
}

/**
 * The relations the inspector offers for an edge, from what its two blocks are
 * and what they are built with (see `relationOptions`).
 */
export function edgeRelationOptions(
	nodes: Node[],
	edge: Edge | null,
	lang: Lang,
): string[] {
	const pair = ends(nodes, edge);
	return pair ? relationOptions(pair[0], pair[1], lang) : [];
}

/** What does not fit between the stacks of an edge's two blocks. */
export function edgeStackWarnings(
	nodes: Node[],
	edge: Edge | null,
	lang: Lang,
	resolve: (stack: string) => string,
): string[] {
	const pair = ends(nodes, edge);
	return pair ? stackWarnings(pair[0], pair[1], lang, resolve) : [];
}

/**
 * Drawing a wire between two blocks. A coherent pair is linked straight away
 * with its spoken relation, and a stack mismatch is pointed out (the link
 * stays). A pair the architecture rules do not foresee is no longer refused
 * outright: the person is told *why* it is unusual and what usually goes in
 * between; when it was only drawn backwards they can flip it, and they can
 * always link it anyway ("Relier quand même"). A forced wire is dashed.
 */
export function useConnectBlocks(
	nodes: Node[],
	edges: Edge[],
	setEdges: SetEdges,
	lang: Lang,
) {
	const { t } = useTranslation("visualProgramming");

	return useCallback(
		(params: Edge | Connection) => {
			const src = nodes.find((n) => n.id === params.source);
			const tgt = nodes.find((n) => n.id === params.target);
			const srcType = src?.data?.type as string | undefined;
			const tgtType = tgt?.data?.type as string | undefined;
			const exists = (eds: Edge[], from?: string | null, to?: string | null) =>
				eds.some((e) => e.source === from && e.target === to);
			// Drawing the same connection twice produced two overlapping edges, two
			// labels stacked on each other, and a duplicated line in the spec.
			if (exists(edges, params.source, params.target)) {
				toast({
					title: t("duplicateConnection", "Connexion déjà présente"),
					description: t(
						"duplicateConnectionDesc",
						"Ces deux blocs sont déjà reliés dans ce sens.",
					),
				});
				return;
			}
			const names = {
				source: String(src?.data?.label ?? params.source),
				target: String(tgt?.data?.label ?? params.target),
			};
			const verdict = connectionVerdict(srcType, tgtType, names, lang, (k) =>
				t(k),
			);
			const label = connectionLabel(srcType, tgtType, lang);
			if (verdict.ok) {
				setEdges((eds) => addEdge({ ...params, data: { label } }, eds));
				const warnings = stackWarnings(endInfo(src), endInfo(tgt), lang, (k) =>
					t(k, k),
				);
				if (warnings.length > 0) {
					toast({
						title: t("stackMismatch", "Lien ajouté, mais les technologies ne collent pas"),
						description: warnings.join(" "),
					});
				}
				return;
			}
			const force = () =>
				setEdges((eds) =>
					exists(eds, params.source, params.target)
						? eds
						: addEdge({ ...params, data: { label, forced: true } }, eds),
				);
			const flip = () =>
				setEdges((eds) =>
					exists(eds, params.target, params.source)
						? eds
						: addEdge(
								{
									id: `reactflow__edge-${params.target}-${params.source}`,
									source: params.target as string,
									target: params.source as string,
									data: { label: connectionLabel(tgtType, srcType, lang) },
								},
								eds,
							),
				);
			const via = (verdict.via ?? [])
				.map((type) => t(type))
				.join(lang === "fr" ? " ou " : " or ");
			const forceLabel = t("forceConnection", "Relier quand même");
			const flipLabel = t("flipConnection", "Inverser le sens");
			toast({
				title: t("unusualConnection", "Connexion inhabituelle"),
				description: `${verdict.reason} (${names.source} → ${names.target})${
					via ? ` ${t("connectionVia", "À intercaler : {{via}}.", { via })}` : ""
				}`,
				action: (
					<div className="flex flex-col gap-1.5">
						{verdict.reversed ? (
							<ToastAction altText={flipLabel} onClick={flip}>
								{flipLabel}
							</ToastAction>
						) : null}
						<ToastAction altText={forceLabel} onClick={force}>
							{forceLabel}
						</ToastAction>
					</div>
				),
			});
		},
		[nodes, edges, setEdges, lang, t],
	);
}
