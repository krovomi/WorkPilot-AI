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
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { useBrainStore } from "../../stores/brain-store";
import { useHermesStore } from "../../stores/hermes-store";
import { ScrollArea } from "../ui/scroll-area";
import { BrainTaskCard } from "./BrainTaskCard";
import { DocumentInsightsCard } from "./DocumentInsightsCard";
import { VerifyLoopCard } from "./VerifyLoopCard";
import { VisualReviewCard } from "./VisualReviewCard";
import { ExecutionFormulaBanner } from "./ExecutionFormulaBanner";
import { HermesLearningCard } from "./HermesLearningCard";
import { RtkSavingsCard } from "./RtkSavingsCard";
import { SpecInterviewBanner } from "./SpecInterviewDialog";
import { SpecTraceabilityCard } from "./SpecTraceabilityCard";
import { TaskJevCard } from "./TaskJevCard";
import { TaskMetadata } from "./TaskMetadata";
import { UiUxDesignCard } from "./UiUxDesignCard";
import { WorkflowProfileCard } from "./WorkflowProfileCard";

export type OverviewSectionId = "review" | "task" | "plan" | "learning";

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
 *
 * **La barre de raccourcis ne défile pas.** Elle était `sticky` à l'intérieur
 * de la zone qui défile, sous un parent en `overflow-x-hidden` — ce qui fait de
 * ce parent un conteneur de défilement qui ne défile jamais, et d'un `sticky`
 * un élément ordinaire : la barre partait avec le contenu. Elle est maintenant
 * *au-dessus* de la zone de défilement, que ce composant possède, et elle est
 * toujours rendue — une barre qui apparaît quand une carte asynchrone arrive
 * pousse tout le contenu d'un cran sous les yeux de la personne. Le raccourci
 * de la section lue est mis en évidence.
 */
export function TaskOverview({
	task,
	projectPath,
	review,
	editable = true,
	onOpenVerify,
}: TaskOverviewProps) {
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

	const viewport = useRef<HTMLDivElement | null>(null);
	const onViewportRef = useCallback((node: HTMLDivElement | null) => {
		viewport.current = node;
	}, []);
	const [active, setActive] = useState<OverviewSectionId | null>(null);

	// La section lue : la dernière dont le titre a passé le haut de la zone.
	// Lu au défilement plutôt qu'avec un IntersectionObserver : ses marges ne
	// s'appliquent qu'à la fenêtre, pas à une zone qui défile dans un dialogue.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `present` — a section appearing or vanishing moves the others
	useEffect(() => {
		const node = viewport.current;
		if (!node) return;
		const update = () => {
			const top = node.getBoundingClientRect().top + 32;
			let current: OverviewSectionId | null = null;
			for (const id of SECTION_ORDER) {
				const el = document.getElementById(sectionDomId(task.id, id));
				if (!el || el.hidden) continue;
				if (el.getBoundingClientRect().top <= top) current = id;
			}
			// Tout en bas, la dernière section est la lue même si son titre
			// n'atteint jamais le haut : sinon son raccourci ne s'allume jamais.
			if (node.scrollTop + node.clientHeight >= node.scrollHeight - 2) {
				const last = [...SECTION_ORDER].reverse().find((id) => {
					const el = document.getElementById(sectionDomId(task.id, id));
					return el && !el.hidden;
				});
				if (last) current = last;
			}
			setActive(current);
		};
		update();
		node.addEventListener("scroll", update, { passive: true });
		return () => node.removeEventListener("scroll", update);
	}, [task.id, present]);

	const jump = (id: OverviewSectionId) =>
		document
			.getElementById(sectionDomId(task.id, id))
			?.scrollIntoView({ behavior: "smooth", block: "start" });

	return (
		<div className="flex h-full min-h-0 flex-col">
			<nav
				aria-label={t("tasks:overview.nav")}
				className="flex shrink-0 flex-wrap gap-1.5 border-b border-border/60 bg-background/40 px-5 py-2.5"
			>
				{visible.map(({ id, icon: Icon, badge, attention }) => (
					<button
						key={id}
						type="button"
						onClick={() => jump(id)}
						aria-current={active === id ? "location" : undefined}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
							attention
								? "border-warning/50 bg-warning/10 text-foreground hover:bg-warning/20"
								: active === id
									? "border-primary/50 bg-primary/10 text-foreground"
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

			<ScrollArea className="min-h-0 flex-1" onViewportRef={onViewportRef}>
				<div className="max-w-full space-y-7 overflow-x-hidden p-5">
					{/* Préalables : ils bloquent un démarrage, ils passent avant tout. */}
					<div className="space-y-3 empty:hidden">
						<SpecInterviewBanner task={task} />
						<ExecutionFormulaBanner task={task} />
					</div>

					{review && (
						<OverviewSection taskId={task.id} id="review" icon={ClipboardCheck} tone="warning" onPresence={report}>
							{review}
						</OverviewSection>
					)}

					<OverviewSection taskId={task.id} id="task" icon={BookOpen} tone="primary" onPresence={report}>
						<TaskMetadata task={task} editable={editable} />
					</OverviewSection>

					<OverviewSection taskId={task.id} id="plan" icon={Route} tone="amber" onPresence={report}>
						<WorkflowProfileCard task={task} projectPath={projectPath} />
						<TaskJevCard task={task} projectPath={projectPath} />
						<SpecTraceabilityCard task={task} projectPath={projectPath} />
						<DocumentInsightsCard task={task} projectPath={projectPath} />
						{/* Le design system d'une tâche qui touche l'interface
						    (ui-ux-pro-max). Rien sur une tâche backend. */}
						<UiUxDesignCard task={task} projectPath={projectPath} />
						{/* Ce que montrent les captures de l'application, lues par OCR :
						    clés brutes, langue, libellés coupés, base → tâche, maquette.
						    Rien sans capture. */}
						<VisualReviewCard task={task} projectPath={projectPath} />
						{/* La boucle de vérification : l'app lancée, corrigée, amenée
						    jusqu'au changement et mesurée. Rien tant qu'elle n'a pas tourné. */}
						<VerifyLoopCard task={task} projectPath={projectPath} onOpenDetails={onOpenVerify} />
					</OverviewSection>

					<OverviewSection taskId={task.id} id="learning" icon={BrainCircuit} tone="violet" onPresence={report}>
						<HermesLearningCard task={task} projectPath={projectPath} />
						<BrainTaskCard task={task} projectPath={projectPath} />
						<RtkSavingsCard projectPath={projectPath} />
					</OverviewSection>
				</div>
			</ScrollArea>
		</div>
	);
}

const SECTION_ORDER: readonly OverviewSectionId[] = ["review", "task", "plan", "learning"];

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

	// Layout, pas effect : la première réponse arrive avant le premier rendu à
	// l'écran, donc une section vide n'apparaît pas une image avant de partir.
	useLayoutEffect(() => {
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
			className="scroll-mt-4 space-y-3"
		>
			{/* Pas de filet horizontal : entre un titre et la carte qu'il annonce,
			    un trait se lisait comme une frontière de plus, pas comme un lien. */}
			<header className="flex items-start gap-2.5">
				<span className={cn("mt-0.5 rounded-md p-1.5", TONES[tone])}>
					<Icon className="h-3.5 w-3.5" aria-hidden />
				</span>
				<div className="min-w-0">
					<h2
						id={`${sectionDomId(taskId, id)}-title`}
						className="text-sm font-semibold text-foreground"
					>
						{t(`tasks:overview.sections.${id}.title`)}
					</h2>
					<p className="text-xs text-muted-foreground">
						{t(`tasks:overview.sections.${id}.hint`)}
					</p>
				</div>
			</header>
			<div ref={body} className="space-y-3">
				{children}
			</div>
		</section>
	);
}
