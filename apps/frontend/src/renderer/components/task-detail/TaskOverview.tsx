import {
	BookOpen,
	BrainCircuit,
	ClipboardCheck,
	Route,
	type LucideIcon,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { useBrainStore } from "../../stores/brain-store";
import { useHermesStore } from "../../stores/hermes-store";
import { BrainTaskCard } from "./BrainTaskCard";
import { DocumentInsightsCard } from "./DocumentInsightsCard";
import { ExecutionFormulaBanner } from "./ExecutionFormulaBanner";
import { HermesLearningCard } from "./HermesLearningCard";
import { RtkSavingsCard } from "./RtkSavingsCard";
import { SpecInterviewBanner } from "./SpecInterviewDialog";
import { SpecTraceabilityCard } from "./SpecTraceabilityCard";
import { TaskJevCard } from "./TaskJevCard";
import { TaskMetadata } from "./TaskMetadata";
import { WorkflowProfileCard } from "./WorkflowProfileCard";

export type OverviewSectionId = "review" | "task" | "plan" | "learning";

export interface TaskOverviewProps {
	readonly task: Task;
	readonly projectPath?: string;
	/** La revue humaine, construite par le modal qui en détient l'état. */
	readonly review?: ReactNode;
}

/**
 * L'onglet « Vue d'ensemble », rangé par la question que se pose la personne.
 *
 * Il empilait dix blocs dans l'ordre où ils avaient été écrits : bannières,
 * profil d'exécution, traçabilité, pièces jointes, hermes, rtk, cerveau — puis,
 * tout en bas, la description de la tâche elle-même, et plus bas encore la
 * revue humaine, c'est-à-dire la seule chose qu'on vient faire quand une tâche
 * attend une revue. Quatre sections, dans l'ordre où l'on lit :
 *
 * | Section | Répond à | Contient |
 * |---|---|---|
 * | **À traiter** | que dois-je faire, là, maintenant ? | la revue humaine (quand la tâche l'attend) |
 * | **La tâche** | de quoi parle-t-on ? | description, critères d'acceptation, métadonnées |
 * | **Plan d'exécution** | que vont faire les agents, et sur quoi ? | profil d'effort, second avis JEV, traçabilité, pièces jointes et ADR |
 * | **Mémoire & apprentissage** | qu'est-ce que le système retient ? | cerveau partagé, boucle hermes, économies rtk |
 *
 * Les bannières qui bloquent un démarrage (entretien de spec, formule
 * d'exécution) restent au-dessus de tout : elles ne sont pas un sujet, elles
 * sont un préalable.
 *
 * Chaque carte décide seule de s'afficher — la plupart ne rendent rien quand
 * elles n'ont rien à dire. Une section dont toutes les cartes se sont tues
 * disparaît avec son titre, et son raccourci disparaît de la barre de
 * navigation : un titre au-dessus d'un vide est un titre qu'on apprend à
 * sauter. C'est pour cela que la présence est *observée* dans le DOM
 * (`MutationObserver`) plutôt que devinée : dix cartes ont chacune leur règle,
 * et en recopier dix ici serait dix occasions de se tromper.
 */
export function TaskOverview({ task, projectPath, review }: TaskOverviewProps) {
	const { t } = useTranslation(["tasks"]);
	const [present, setPresent] = useState<Record<OverviewSectionId, boolean>>({
		review: Boolean(review),
		task: true,
		plan: false,
		learning: false,
	});
	const report = useCallback((id: OverviewSectionId, has: boolean) => {
		setPresent((prev) => (prev[id] === has ? prev : { ...prev, [id]: has }));
	}, []);

	// Ce qui attend une décision dans « Mémoire & apprentissage » : les skills
	// hermes à trancher et les règles que les agents proposent au cerveau.
	const hermesPending = useHermesStore((s) =>
		s.status?.readiness.installed ? (s.status.candidates?.length ?? s.status.pending.length) : 0,
	);
	const brainProposals = useBrainStore(
		(s) => s.byTask[task.id]?.learning?.proposals.length ?? 0,
	);

	const sections: {
		id: OverviewSectionId;
		icon: LucideIcon;
		badge?: number;
		attention?: boolean;
	}[] = [
		{ id: "review", icon: ClipboardCheck, attention: true },
		{ id: "task", icon: BookOpen },
		{ id: "plan", icon: Route },
		{
			id: "learning",
			icon: BrainCircuit,
			badge: hermesPending + brainProposals,
		},
	];
	const visible = sections.filter((s) => present[s.id]);

	const jump = (id: OverviewSectionId) =>
		document
			.getElementById(sectionDomId(task.id, id))
			?.scrollIntoView({ behavior: "smooth", block: "start" });

	return (
		<div className="max-w-full space-y-6 overflow-x-hidden p-5 pt-0">
			{visible.length > 1 && (
				<nav
					aria-label={t("tasks:overview.nav")}
					className="sticky top-0 z-10 -mx-5 flex flex-wrap gap-1.5 border-b border-border/60 bg-background/85 px-5 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70"
				>
					{visible.map(({ id, icon: Icon, badge, attention }) => (
						<button
							key={id}
							type="button"
							onClick={() => jump(id)}
							className={cn(
								"inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
								attention
									? "border-warning/50 bg-warning/10 text-foreground hover:bg-warning/20"
									: "border-border bg-card/60 text-muted-foreground hover:bg-muted hover:text-foreground",
							)}
						>
							<Icon className="h-3.5 w-3.5" aria-hidden />
							{t(`tasks:overview.sections.${id}.title`)}
							{badge ? (
								<span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold leading-4 text-warning-foreground">
									{badge}
								</span>
							) : null}
						</button>
					))}
				</nav>
			)}

			{/* Préalables : ils bloquent un démarrage, ils passent avant tout. */}
			<div className={cn("space-y-3", visible.length <= 1 && "pt-5")}>
				<SpecInterviewBanner task={task} />
				<ExecutionFormulaBanner task={task} />
			</div>

			{review && (
				<OverviewSection taskId={task.id} id="review" icon={ClipboardCheck} tone="warning" onPresence={report}>
					{review}
				</OverviewSection>
			)}

			<OverviewSection taskId={task.id} id="task" icon={BookOpen} tone="primary" onPresence={report}>
				<TaskMetadata task={task} />
			</OverviewSection>

			<OverviewSection taskId={task.id} id="plan" icon={Route} tone="amber" onPresence={report}>
				<WorkflowProfileCard task={task} projectPath={projectPath} />
				<TaskJevCard task={task} projectPath={projectPath} />
				<SpecTraceabilityCard task={task} projectPath={projectPath} />
				<DocumentInsightsCard task={task} projectPath={projectPath} />
			</OverviewSection>

			<OverviewSection taskId={task.id} id="learning" icon={BrainCircuit} tone="violet" onPresence={report}>
				<HermesLearningCard task={task} projectPath={projectPath} />
				<BrainTaskCard task={task} projectPath={projectPath} />
				<RtkSavingsCard projectPath={projectPath} />
			</OverviewSection>
		</div>
	);
}

function sectionDomId(taskId: string, id: OverviewSectionId): string {
	return `task-${taskId}-overview-${id}`;
}

const TONES = {
	warning: "bg-warning/10 text-warning",
	primary: "bg-primary/10 text-primary",
	amber: "bg-amber-500/10 text-amber-500",
	violet: "bg-violet-500/10 text-violet-500",
} as const;

function OverviewSection({
	taskId,
	id,
	icon: Icon,
	tone,
	onPresence,
	children,
}: {
	readonly taskId: string;
	readonly id: OverviewSectionId;
	readonly icon: LucideIcon;
	readonly tone: keyof typeof TONES;
	readonly onPresence: (id: OverviewSectionId, has: boolean) => void;
	readonly children: ReactNode;
}) {
	const { t } = useTranslation(["tasks"]);
	const body = useRef<HTMLDivElement>(null);
	const [has, setHas] = useState(true);

	useEffect(() => {
		const node = body.current;
		if (!node) return;
		const update = () => {
			const next = node.childElementCount > 0;
			setHas(next);
			onPresence(id, next);
		};
		update();
		const observer = new MutationObserver(update);
		observer.observe(node, { childList: true });
		return () => {
			observer.disconnect();
			onPresence(id, false);
		};
	}, [id, onPresence]);

	return (
		<section
			id={sectionDomId(taskId, id)}
			aria-labelledby={`${sectionDomId(taskId, id)}-title`}
			hidden={!has}
			className="scroll-mt-14 space-y-3"
		>
			<header className="flex items-center gap-2.5">
				<span className={cn("rounded-md p-1.5", TONES[tone])}>
					<Icon className="h-3.5 w-3.5" aria-hidden />
				</span>
				<div className="min-w-0">
					<h2
						id={`${sectionDomId(taskId, id)}-title`}
						className="text-xs font-semibold uppercase tracking-wider text-foreground/80"
					>
						{t(`tasks:overview.sections.${id}.title`)}
					</h2>
					<p className="text-[11px] text-muted-foreground">
						{t(`tasks:overview.sections.${id}.hint`)}
					</p>
				</div>
				<span className="ml-2 h-px flex-1 bg-border/70" aria-hidden />
			</header>
			<div ref={body} className="space-y-3">
				{children}
			</div>
		</section>
	);
}
