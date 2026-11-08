import { useAgenticCapabilities } from "../../hooks/useAgenticCapabilities";
import { useAirgapStatus } from "../../hooks/useAirgapStatus";
import { AirgapBanner } from "../offline-mode/AirgapBanner";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { buildModelSelectOptions } from "../../../shared/utils/task-thinking";
import { isLocalProvider } from "../../../shared/utils/local-models";
import { Plus, Swords, Trash2, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PROVIDER_MODELS_MAP } from "@shared/constants/models";
import { useBountyBoardStore } from "../../stores/bounty-board-store";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
} from "../charter";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { ContestantCard } from "./ContestantCard";
import { JudgeVerdictModal } from "./JudgeVerdictModal";
import { formatAppDateTime } from "@/lib/date-format";

const PROVIDERS = Object.keys(PROVIDER_MODELS_MAP).sort((a, b) =>
	a.localeCompare(b),
);

function firstModelFor(provider: string): string {
	const list = PROVIDER_MODELS_MAP[provider];
	return list && list.length > 0 ? list[0].value : "";
}

function ContestantModelSelect({
	provider,
	value,
	onChange,
}: {
	provider: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const { models } = useProviderModelCatalog(provider);
	const selection = buildModelSelectOptions(
		models,
		value,
		{},
		isLocalProvider(provider),
	);
	return (
		<Select value={selection.value} onValueChange={onChange}>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{selection.options.map((m) => (
					<SelectItem key={m.value} value={m.value}>
						{m.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

interface Props {
	readonly projectPath?: string;
	readonly specId?: string;
}

export function BountyBoardView({ projectPath, specId }: Props) {
	const { t } = useTranslation(["bountyBoard", "common", "navigation"]);
	const {
		contestants,
		current,
		archives,
		loading,
		error,
		addContestant,
		updateContestant,
		removeContestant,
		startBounty,
		loadArchives,
	} = useBountyBoardStore();

	// Un fournisseur sans adaptateur agentique tourne sur le SDK Claude : la
	// victoire serait enregistrée au nom d'un éditeur qui n'a jamais vu le
	// prompt. Le backend refuse le participant (`bounty_board/runner.py`) ; ceci
	// le dit *avant* qu'un round soit dépensé à l'apprendre.
	const { degradesTo } = useAgenticCapabilities();

	// Le mode hors-ligne strict remplace le fournisseur de chaque participant
	// par le modèle local que la politique nomme : un plateau de trois
	// fournisseurs cloud devient trois fois la même erreur, parlant d'un
	// fournisseur que personne n'a choisi. Le backend refuse désormais chaque
	// participant cloud ; ceci le dit avant qu'on clique.
	const airgap = useAirgapStatus(projectPath);

	const tasks = useTaskStore((s) => s.tasks);
	const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
	// Same resolution as App's `selectedProject`, so the list never mixes in
	// another project's specs.
	const projectId = useProjectStore(
		(s) => s.activeProjectId || s.selectedProjectId,
	);

	const [projectInput] = useState(projectPath ?? "");
	const [specInput, setSpecInput] = useState("");
	const [verdictOpen, setVerdictOpen] = useState(false);

	// The only specs a round can run on: the project's existing ones, derived
	// from its loaded tasks (no extra IPC). There is deliberately no free-text
	// fallback — a typed id that names no spec folder used to launch a round on
	// nothing; the main process refuses such an id too.
	const availableSpecs = useMemo(() => {
		const seen = new Map<string, string>();
		for (const task of tasks) {
			if (projectId && task.projectId !== projectId) continue;
			if (task.specId && !seen.has(task.specId)) {
				seen.set(task.specId, task.title || task.specId);
			}
		}
		return Array.from(seen, ([id, title]) => ({ id, title })).sort((a, b) =>
			a.id.localeCompare(b.id),
		);
	}, [tasks, projectId]);

	// Prefer the explicit prop, then the currently-selected task's spec, then
	// the first available spec — so the field is rarely empty on open.
	const isKnownSpec = (id: string) => availableSpecs.some((s) => s.id === id);
	const preferredSpecId = useMemo(() => {
		const known = (id?: string) =>
			id && availableSpecs.some((s) => s.id === id) ? id : "";
		const selected = tasks.find((t) => t.id === selectedTaskId)?.specId;
		return known(specId) || known(selected) || availableSpecs[0]?.id || "";
	}, [specId, tasks, selectedTaskId, availableSpecs]);

	// Keep the choice inside the list: a spec deleted since, or one from the
	// project shown before, is replaced rather than sent.
	useEffect(() => {
		if (specInput && availableSpecs.some((s) => s.id === specInput)) return;
		if (specInput !== preferredSpecId) setSpecInput(preferredSpecId);
	}, [preferredSpecId, specInput, availableSpecs]);

	useEffect(() => {
		if (projectInput && availableSpecs.some((s) => s.id === specInput)) {
			void loadArchives(projectInput, specInput);
		}
	}, [projectInput, specInput, availableSpecs, loadArchives]);

	useEffect(() => {
		if (current?.status === "completed") {
			setVerdictOpen(true);
		}
	}, [current]);

	const canStart = Boolean(
		!loading &&
			projectInput.trim() &&
			isKnownSpec(specInput) &&
			contestants.length > 0,
	);

	// Explain why the launch button is disabled instead of leaving it inert.
	const disabledReason = loading
		? null
		: !projectInput.trim()
			? t("bountyBoard:hint.selectProject", "Select a project first.")
			: availableSpecs.length === 0
				? t(
						"bountyBoard:hint.noSpecs",
						"This project has no spec yet: create a task first.",
					)
				: !isKnownSpec(specInput)
					? t("bountyBoard:hint.selectSpec", "Choose a spec to launch.")
					: contestants.length === 0
						? t("bountyBoard:hint.addContestant", "Add at least one contestant.")
						: null;

	const handleStart = () => {
		if (!canStart) return;
		void startBounty(projectInput.trim(), specInput);
	};

	return (
		<ModuleStage data-testid="bounty-board-view">
			<ModuleHeader
				kicker={t("navigation:groups.agents")}
				icon={Swords}
				title={t("bountyBoard:title", "Bounty Board")}
				description={t(
					"bountyBoard:description",
					"Run N contestants in parallel with different provider/model combinations. An impartial judge picks the winner.",
				)}
				tone="orange"
			/>
			<div className="relative z-[2] px-5">
				<AirgapBanner status={airgap} blockedLabel={t("bountyBoard:airgapBody")} />
			</div>
			<Columns template="minmax(340px, 42%) minmax(300px, 1fr)">
				<Column
					kicker={t("bountyBoard:kickers.setup", "Setup")}
					title={t("bountyBoard:contestants", "Contestants")}
					meta={String(contestants.length)}
					tone="orange"
					actions={
						<CharterButton
							size="sm"
							icon={Plus}
							onClick={() =>
								addContestant({
									provider: "anthropic",
									model: firstModelFor("anthropic"),
								})
							}
						>
							{t("bountyBoard:addContestant", "Add contestant")}
						</CharterButton>
					}
				>
					<div className="flex flex-col gap-3">
						<Panel>
							<Label className="wp-kicker mb-1 block" htmlFor="bounty-spec">
								{t("bountyBoard:specId", "Spec")}
							</Label>
							<Select value={specInput} onValueChange={setSpecInput} disabled={availableSpecs.length === 0}>
								<SelectTrigger id="bounty-spec" data-testid="bounty-spec-select">
									<SelectValue
										placeholder={
											availableSpecs.length === 0
												? t("bountyBoard:noSpecs", "No spec in this project")
												: t("bountyBoard:selectSpec", "Select a spec")
										}
									/>
								</SelectTrigger>
								<SelectContent searchable={availableSpecs.length > 8}>
									{availableSpecs.map((s) => (
										<SelectItem key={s.id} value={s.id}>
											{s.title === s.id ? s.id : `${s.title} (${s.id})`}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{projectInput && (
								<p className="wp-meta mt-2 truncate" title={projectInput}>
									{t("bountyBoard:projectPath", "Project path")} · {projectInput}
								</p>
							)}
						</Panel>
						{contestants.map((c, idx) => (
							<Panel key={`${c.provider}-${c.model}-${idx}`} rail tone={degradesTo(c.provider) ? "red" : "orange"}>
								<div className="mb-2 flex items-center justify-between">
									<span className="wp-kicker">
										{String(idx + 1).padStart(2, "0")} · {t("bountyBoard:contestant", "Contestant")}
									</span>
									<CharterButton
										size="sm"
										variant="ghost"
										icon={Trash2}
										onClick={() => removeContestant(idx)}
										disabled={contestants.length <= 1}
										aria-label={t("bountyBoard:remove", "Remove contestant")}
									/>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<div>
										<Label className="text-3xs">{t("bountyBoard:field.provider", "Provider")}</Label>
										<Select
											value={c.provider}
											onValueChange={(provider) =>
												updateContestant(idx, {
													provider,
													model: firstModelFor(provider),
												})
											}
										>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
											<SelectContent searchable>
												{PROVIDERS.map((p) => (
													<SelectItem key={p} value={p}>
														{degradesTo(p)
															? t("bountyBoard:noAdapterOption", {
																	provider: p,
																	target: degradesTo(p),
																	defaultValue: "{{provider}} — runs on {{target}}",
																})
															: p}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div>
										<Label className="text-3xs">{t("bountyBoard:field.model", "Model")}</Label>
										<ContestantModelSelect
											provider={c.provider}
											value={c.model}
											onChange={(model) => updateContestant(idx, { model })}
										/>
									</div>
									<div className="col-span-2">
										<Label className="text-3xs">{t("bountyBoard:field.profile", "Profile (optional)")}</Label>
										<Input
											value={c.profileId ?? ""}
											onChange={(e) => updateContestant(idx, { profileId: e.target.value })}
										/>
									</div>
								</div>
								{degradesTo(c.provider) && (
									<p className="mt-2 text-3xs text-destructive">
										{t("bountyBoard:noAdapter", {
											provider: c.provider,
											target: degradesTo(c.provider),
											defaultValue: "No agentic adapter: this entry would run on {{target}} and is refused.",
										})}
									</p>
								)}
							</Panel>
						))}
					</div>
				</Column>
				<Column
					kicker={t("bountyBoard:kickers.board", "Board")}
					title={t("bountyBoard:liveBoard", "Live board")}
					tone="green"
				>
					{loading && <ScanLine label={t("bountyBoard:running", "Running…")} />}
					{!current && !loading && (
						<EmptyStage icon={Trophy} title={t("bountyBoard:emptyTitle", "No round yet")} tone="green">
							{t(
								"bountyBoard:emptyHint",
								"Pick a spec, line up the contestants, then start: each one works in its own worktree and the judge picks the winner.",
							)}
						</EmptyStage>
					)}
					{current && (
						<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
							{current.contestants.map((c) => (
								<ContestantCard
									key={c.id}
									contestant={c}
									isWinner={c.id === current.winnerId}
									rationale={current.judgeRationale?.[c.id]}
								/>
							))}
						</div>
					)}
					{archives.length > 0 && (
						<div className="mt-4">
							<span className="wp-kicker mb-2 block">{t("bountyBoard:archives", "Previous rounds")}</span>
							<div className="flex flex-col gap-2">
								{archives.slice(0, 10).map((a) => (
									<Panel key={a.id} className="flex flex-wrap items-center gap-3 text-xs">
										<span className="wp-mono">{formatAppDateTime(a.createdAt)}</span>
										<span className="wp-muted">
											{t("bountyBoard:contestantsCount", {
												count: a.contestants.length,
												defaultValue: "{{count}} contestants",
											})}
										</span>
										{a.winnerId ? (
											<Chip tone="green">{a.contestants.find((c) => c.id === a.winnerId)?.label}</Chip>
										) : (
											<span className="wp-faint">—</span>
										)}
									</Panel>
								))}
							</div>
						</div>
					)}
				</Column>
			</Columns>
			{error && (
				<Notice tone="red" role="alert" className="relative z-[2] mx-5 mb-2">
					{error}
				</Notice>
			)}
			<Composer
				prompt={
					<span className="wp-muted flex min-w-0 items-center gap-2 text-xs">
						<Swords className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						<span className="truncate">
							{t("bountyBoard:contestantsCount", {
								count: contestants.length,
								defaultValue: "{{count}} contestants",
							})}
						</span>
					</span>
				}
				hint={disabledReason ?? undefined}
				actions={
					<CharterButton variant="primary" icon={Swords} busy={loading} onClick={handleStart} disabled={!canStart}>
						{loading ? t("bountyBoard:running", "Running…") : t("bountyBoard:start", "Start bounty")}
					</CharterButton>
				}
			/>
			{current && verdictOpen && <JudgeVerdictModal result={current} onClose={() => setVerdictOpen(false)} />}
		</ModuleStage>
	);
}
