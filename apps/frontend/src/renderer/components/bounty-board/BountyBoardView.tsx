import { useAgenticCapabilities } from "../../hooks/useAgenticCapabilities";
import { useAirgapStatus } from "../../hooks/useAirgapStatus";
import { AirgapBanner } from "../offline-mode/AirgapBanner";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { buildModelSelectOptions } from "../../../shared/utils/task-thinking";
import { isLocalProvider } from "../../../shared/utils/local-models";
import { Plus, Swords, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PROVIDER_MODELS_MAP } from "@shared/constants/models";
import { useBountyBoardStore } from "../../stores/bounty-board-store";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
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
	const { t } = useTranslation(["bountyBoard", "common"]);
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
		<div className="flex flex-col gap-4 p-4">
			<header className="flex items-center gap-2">
				<Swords className="w-5 h-5" />
				<h2 className="text-lg font-semibold">
					{t("bountyBoard:title", "Bounty Board")}
				</h2>
			</header>

			<p className="text-sm text-muted-foreground">
				{t(
					"bountyBoard:description",
					"Run N contestants in parallel with different provider/model combinations. An impartial judge picks the winner.",
				)}
			</p>

			<AirgapBanner
				status={airgap}
				blockedLabel={t("bountyBoard:airgapBody")}
			/>

			<section className="grid grid-cols-1 md:grid-cols-2 gap-2">
				<div>
					<Label className="text-xs">
						{t("bountyBoard:projectPath", "Project path")}
					</Label>
					<Input
						value={projectInput}
						readOnly
						disabled
						placeholder="/path/to/repo"
						className="bg-muted cursor-not-allowed"
					/>
				</div>
				<div>
					<Label className="text-xs" htmlFor="bounty-spec">
						{t("bountyBoard:specId", "Spec")}
					</Label>
					<Select
						value={specInput}
						onValueChange={setSpecInput}
						disabled={availableSpecs.length === 0}
					>
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
				</div>
			</section>

			<section className="space-y-2">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">
						{t("bountyBoard:contestants", "Contestants")}
					</h3>
					<Button
						size="sm"
						variant="outline"
						onClick={() =>
							addContestant({
								provider: "anthropic",
								model: firstModelFor("anthropic"),
							})
						}
					>
						<Plus className="w-3 h-3 mr-1" />
						{t("bountyBoard:addContestant", "Add contestant")}
					</Button>
				</div>

				<div className="space-y-2">
					{contestants.map((c, idx) => (
						<div
							key={`${c.provider}-${c.model}-${idx}`}
							className="grid grid-cols-12 gap-2 items-end border rounded-md p-2 bg-card"
						>
							<div className="col-span-4">
								<Label className="text-[10px]">
									{t("bountyBoard:field.provider", "Provider")}
								</Label>
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
								{degradesTo(c.provider) && (
									<p className="text-[10px] text-destructive mt-1">
										{t("bountyBoard:noAdapter", {
											provider: c.provider,
											target: degradesTo(c.provider),
											defaultValue:
												"No agentic adapter: this entry would run on {{target}} and is refused.",
										})}
									</p>
								)}
							</div>
							<div className="col-span-4">
								<Label className="text-[10px]">
									{t("bountyBoard:field.model", "Model")}
								</Label>
								<ContestantModelSelect
									provider={c.provider}
									value={c.model}
									onChange={(model) => updateContestant(idx, { model })}
								/>
							</div>
							<div className="col-span-3">
								<Label className="text-[10px]">
									{t("bountyBoard:field.profile", "Profile (optional)")}
								</Label>
								<Input
									value={c.profileId ?? ""}
									onChange={(e) =>
										updateContestant(idx, { profileId: e.target.value })
									}
								/>
							</div>
							<div className="col-span-1 flex justify-end">
								<Button
									size="icon"
									variant="ghost"
									onClick={() => removeContestant(idx)}
									disabled={contestants.length <= 1}
									aria-label={t("bountyBoard:remove", "Remove contestant")}
								>
									<Trash2 className="w-4 h-4" />
								</Button>
							</div>
						</div>
					))}
				</div>
			</section>

			<div className="flex items-center gap-3">
				<Button onClick={handleStart} disabled={!canStart}>
					<Swords className="w-4 h-4 mr-1" />
					{loading
						? t("bountyBoard:running", "Running…")
						: t("bountyBoard:start", "Start bounty")}
				</Button>
				{disabledReason && (
					<span className="text-xs text-muted-foreground">
						{disabledReason}
					</span>
				)}
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			{current && (
				<section>
					<h3 className="text-sm font-semibold mb-2">
						{t("bountyBoard:liveBoard", "Live board")}
					</h3>
					<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
						{current.contestants.map((c) => (
							<ContestantCard
								key={c.id}
								contestant={c}
								isWinner={c.id === current.winnerId}
								rationale={current.judgeRationale?.[c.id]}
							/>
						))}
					</div>
				</section>
			)}

			{archives.length > 0 && (
				<section>
					<h3 className="text-sm font-semibold mb-2">
						{t("bountyBoard:archives", "Previous rounds")}
					</h3>
					<ul className="text-xs space-y-1">
						{archives.slice(0, 10).map((a) => (
							<li key={a.id} className="flex gap-3 text-muted-foreground">
								<span className="font-mono">
									{new Date(a.createdAt).toLocaleString()}
								</span>
								<span>
									{t("bountyBoard:contestantsCount", {
										count: a.contestants.length,
										defaultValue: "{{count}} contestants",
									})}
								</span>
								<span>
									{a.winnerId
										? a.contestants.find((c) => c.id === a.winnerId)?.label
										: "—"}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{current && verdictOpen && (
				<JudgeVerdictModal
					result={current}
					onClose={() => setVerdictOpen(false)}
				/>
			)}
		</div>
	);
}
