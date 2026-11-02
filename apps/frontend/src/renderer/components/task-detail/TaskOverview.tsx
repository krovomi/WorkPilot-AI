import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { useBrainStore } from "../../stores/brain-store";
import { useHermesStore } from "../../stores/hermes-store";
import { useTaskPanelStore } from "../../stores/task-panel-store";
import { TaskPermissionPrompt } from "../task-permission/TaskPermissionPrompt";
import { ScrollArea } from "../ui/scroll-area";
import { BestOfNCard } from "./BestOfNCard";
import { BrainTaskCard } from "./BrainTaskCard";
import { CiPipelineCard } from "./CiPipelineCard";
import { DocumentInsightsCard } from "./DocumentInsightsCard";
import { ExecutionFormulaBanner } from "./ExecutionFormulaBanner";
import { GoalCard } from "./GoalCard";
import { HermesLearningCard } from "./HermesLearningCard";
import { McpAppsCard } from "./McpAppsCard";
import { PanelCardSlot } from "./PanelCardSlot";
import { PanelTabList } from "./PanelTabList";
import {
	PANEL_CARDS,
	PANEL_SECTIONS,
	type PanelCardId,
	type PanelSectionId,
	panelTabDomId,
	panelTabPanelDomId,
} from "./panel-sections";
import { PrFollowupCard } from "./PrFollowupCard";
import { RtkSavingsCard } from "./RtkSavingsCard";
import { SpecInterviewBanner } from "./SpecInterviewDialog";
import { SpecTraceabilityCard } from "./SpecTraceabilityCard";
import { TaskJevCard } from "./TaskJevCard";
import { TaskMetadata } from "./TaskMetadata";
import { UiUxDesignCard } from "./UiUxDesignCard";
import { VerifyLoopCard } from "./VerifyLoopCard";
import { VisualReviewCard } from "./VisualReviewCard";
import { WorkflowProfileCard } from "./WorkflowProfileCard";

export interface TaskOverviewProps {
	readonly task: Task;
	readonly projectPath?: string;
	/** La revue humaine, construite par le modal qui en détient l'état. */
	readonly review?: ReactNode;
	/** Titre, description et critères modifiables en place (faux pendant un run). */
	readonly editable?: boolean;
	/** Ouvre l'onglet « Vérification », quand le modal en propose un. */
	readonly onOpenVerify?: () => void;
}

/**
 * L'onglet « Vue d'ensemble », en trois onglets : Avancement, Qualité, Coûts
 * et contexte. Quelle carte va où, et pourquoi : `panel-sections.ts`.
 *
 * Les trois panneaux restent montés et seuls les inactifs sont `hidden` : les
 * cartes chargent leurs données une fois, chaque onglet sait combien de
 * cartes il montre, et la bannière « ce qui vous attend » peut amener à une
 * carte de n'importe quel onglet. Un onglet dont toutes les cartes se taisent
 * le dit en une ligne, plutôt que de disparaître : la barre d'onglets ne
 * change pas sous le clavier de la personne.
 *
 * L'onglet ouvert est gardé pour la session (`task-panel-store`) : la tâche
 * suivante s'ouvre là où l'on lisait.
 */
export function TaskOverview({
	task,
	projectPath,
	review,
	editable = true,
	onOpenVerify,
}: TaskOverviewProps) {
	const { t } = useTranslation(["tasks"]);
	const section = useTaskPanelStore((s) => s.section);
	const setSection = useTaskPanelStore((s) => s.setSection);
	const [present, setPresent] = useState<Partial<Record<PanelCardId, boolean>>>({});
	const report = useCallback((card: PanelCardId, has: boolean) => {
		setPresent((prev) => (Boolean(prev[card]) === has ? prev : { ...prev, [card]: has }));
	}, []);

	// Ce qui attend une décision dans « Coûts et contexte » : les skills hermes
	// à trancher et les règles que les agents proposent au cerveau.
	const hermesPending = useHermesStore((s) =>
		s.status?.readiness.installed ? (s.status.candidates?.length ?? s.status.pending.length) : 0,
	);
	const brainProposals = useBrainStore(
		(s) => s.byTask[task.id]?.learning?.proposals.length ?? 0,
	);

	// A tab opened by a click starts at its top, not at the previous tab's offset.
	const viewport = useRef<HTMLDivElement | null>(null);
	const onViewportRef = useCallback((node: HTMLDivElement | null) => {
		viewport.current = node;
	}, []);
	const select = (id: PanelSectionId) => {
		setSection(id);
		if (viewport.current) viewport.current.scrollTop = 0;
	};

	const cards: Record<PanelCardId, ReactNode> = {
		// Préalables : ils bloquent un démarrage, ils passent avant tout.
		specInterview: <SpecInterviewBanner task={task} />,
		executionFormula: <ExecutionFormulaBanner task={task} />,
		// La question d'un agent ACP qui attend une réponse pour continuer.
		permission: <TaskPermissionPrompt taskId={task.id} specId={task.specId} />,
		review,
		ciPipeline: <CiPipelineCard task={task} />,
		prFollowup: <PrFollowupCard task={task} />,
		task: <TaskMetadata task={task} editable={editable} />,
		// Le mode objectif : la commande qui dit « fini », et ses plafonds.
		goal: <GoalCard task={task} editable={editable} />,
		// Best-of-N : la tâche construite N fois, classée, la personne choisit.
		bestOfN: <BestOfNCard task={task} editable={editable} />,
		// Les vues MCP Apps des outils appelés pendant le build (iframe sans
		// allow-same-origin). Rien sans vue gardée.
		mcpApps: <McpAppsCard task={task} />,
		jev: <TaskJevCard task={task} projectPath={projectPath} />,
		traceability: <SpecTraceabilityCard task={task} projectPath={projectPath} />,
		// Le design system d'une tâche qui touche l'interface. Rien sur une tâche backend.
		uiux: <UiUxDesignCard task={task} projectPath={projectPath} />,
		// Les captures de l'application lues par OCR. Rien sans capture.
		visualReview: <VisualReviewCard task={task} projectPath={projectPath} />,
		// La boucle de vérification. Rien tant qu'elle n'a pas tourné.
		verifyLoop: (
			<VerifyLoopCard task={task} projectPath={projectPath} onOpenDetails={onOpenVerify} />
		),
		workflowProfile: <WorkflowProfileCard task={task} projectPath={projectPath} />,
		documents: <DocumentInsightsCard task={task} projectPath={projectPath} />,
		hermes: <HermesLearningCard task={task} projectPath={projectPath} />,
		brain: <BrainTaskCard task={task} projectPath={projectPath} />,
		rtk: <RtkSavingsCard projectPath={projectPath} />,
	};

	const count = (id: PanelSectionId) => PANEL_CARDS[id].filter((card) => present[card]).length;
	const decisions = hermesPending + brainProposals;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<PanelTabList
				taskId={task.id}
				active={section}
				onSelect={select}
				badges={{ costs: decisions }}
			/>

			<ScrollArea className="min-h-0 flex-1" onViewportRef={onViewportRef}>
				<div className="max-w-full overflow-x-hidden p-5">
					{PANEL_SECTIONS.map((id) => (
						<div
							key={id}
							role="tabpanel"
							id={panelTabPanelDomId(task.id, id)}
							aria-labelledby={panelTabDomId(task.id, id)}
							hidden={section !== id}
							className="flex flex-col gap-3"
						>
							<p className="text-xs text-muted-foreground">
								{t(`tasks:panel.sections.${id}.hint`)}
							</p>
							{PANEL_CARDS[id].map((card) => (
								<PanelCardSlot key={card} taskId={task.id} card={card} onPresence={report}>
									{cards[card]}
								</PanelCardSlot>
							))}
							{count(id) === 0 && (
								<p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
									{t("tasks:panel.empty")}
								</p>
							)}
						</div>
					))}
				</div>
			</ScrollArea>
		</div>
	);
}
