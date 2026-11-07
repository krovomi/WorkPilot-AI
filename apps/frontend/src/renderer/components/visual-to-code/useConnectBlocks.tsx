import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { addEdge, type Connection, type Edge, type Node } from "reactflow";
import { toast } from "@/hooks/use-toast";
import {
	canConnect,
	connectionLabel,
	type EndInfo,
	type Lang,
	relationOptions,
} from "../../lib/architecture-connections";
import { ToastAction } from "../ui/toast";

type SetEdges = (update: (edges: Edge[]) => Edge[]) => void;

function endInfo(node: Node | undefined): EndInfo {
	return {
		type: node?.data?.type as string | undefined,
		framework: node?.data?.framework as string | undefined,
	};
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
	if (!edge) return [];
	return relationOptions(
		endInfo(nodes.find((n) => n.id === edge.source)),
		endInfo(nodes.find((n) => n.id === edge.target)),
		lang,
	);
}

/**
 * Drawing a wire between two blocks. A coherent pair is linked straight away
 * with its spoken relation. A pair the architecture rules do not foresee is
 * no longer refused outright: the person is told it is unusual and can link
 * it anyway ("Relier quand même"); the wire is then drawn dashed and its
 * relation is theirs to pick or type in the inspector.
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
			// Drawing the same connection twice produced two overlapping edges, two
			// labels stacked on each other, and a duplicated line in the spec.
			if (
				edges.some(
					(e) => e.source === params.source && e.target === params.target,
				)
			) {
				toast({
					title: t("duplicateConnection", "Connexion déjà présente"),
					description: t(
						"duplicateConnectionDesc",
						"Ces deux blocs sont déjà reliés dans ce sens.",
					),
				});
				return;
			}
			const label = connectionLabel(srcType, tgtType, lang);
			if (canConnect(srcType, tgtType)) {
				setEdges((eds) => addEdge({ ...params, data: { label } }, eds));
				return;
			}
			const force = () =>
				setEdges((eds) =>
					eds.some(
						(e) => e.source === params.source && e.target === params.target,
					)
						? eds
						: addEdge({ ...params, data: { label, forced: true } }, eds),
				);
			const forceLabel = t("forceConnection", "Relier quand même");
			toast({
				title: t("unusualConnection", "Connexion inhabituelle"),
				description: `${t(
					"unusualConnectionDesc",
					"Les règles d'architecture ne prévoient pas ce lien. Reliez-les quand même si c'est voulu.",
				)} (${src?.data?.label ?? params.source} → ${tgt?.data?.label ?? params.target})`,
				action: (
					<ToastAction altText={forceLabel} onClick={force}>
						{forceLabel}
					</ToastAction>
				),
			});
		},
		[nodes, edges, setEdges, lang, t],
	);
}
