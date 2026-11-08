import { AlertTriangle, CheckCircle2, Download, KanbanSquare, Search, Square } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	cancelCodeMigration,
	createMigrationTask,
	startCodeMigration,
	useCodeMigrationStore,
} from "../../stores/code-migration-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
	StepCard,
} from "../charter";
import { Textarea } from "../ui/textarea";

/** One example per stack: [example key, stack label]. */
const EXAMPLES = [
	["dotnet", ".NET"],
	["springBoot", "Java"],
	["javaToKotlin", "Kotlin"],
	["angularJs", "Angular"],
	["vue3", "Vue"],
	["reactHooks", "React"],
	["jsToTs", "TypeScript"],
	["asyncAwait", "JavaScript"],
	["python312", "Python"],
	["goModern", "Go"],
	["rustEdition", "Rust"],
	["php8", "PHP"],
	["rails7", "Ruby"],
	["dart3", "Flutter"],
	["swiftAsync", "Swift"],
] as const;

const RUNNING = new Set(["analyzing", "planning", "executing", "validating"]);

/** Migrations of framework, version or language, analysed here and made by a Kanban task. */
export function CodeMigrationDashboard(): React.ReactElement {
	const { t } = useTranslation(["codeMigration", "navigation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const { phase, status, streamingOutput, result, error, migrationDescription, setMigrationDescription } =
		useCodeMigrationStore();
	const [created, setCreated] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const isRunning = RUNNING.has(phase);
	const description = migrationDescription.trim();
	const ready = result?.summary.plan_status === "ready";

	async function handleCreateTask() {
		if (!activeProject || !description) return;
		setCreating(true);
		const title = t("codeMigration:task.title", {
			description: description.length > 80 ? `${description.slice(0, 77)}…` : description,
		});
		const body = [
			description,
			"",
			t("codeMigration:task.scope"),
			t("codeMigration:task.acceptance"),
			result?.plan.source ? t("codeMigration:task.source", { source: result.plan.source }) : "",
		]
			.filter(Boolean)
			.join("\n");
		const ok = await createMigrationTask(activeProject.id, title, body);
		setCreating(false);
		setCreated(ok ? title : null);
	}

	return (
		<ModuleStage data-testid="code-migration-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("codeMigration:title")}
				description={t("codeMigration:subtitle")}
				icon={Download}
				tone="violet"
				actions={
					<CharterButton
						variant="primary"
						icon={KanbanSquare}
						busy={creating}
						onClick={() => void handleCreateTask()}
						disabled={!activeProject || !description || creating}
					>
						{t("codeMigration:actions.createTask")}
					</CharterButton>
				}
			/>

			<Columns template="minmax(0, 1fr) minmax(0, 1.6fr)">
				<Column
					kicker={t("codeMigration:kickers.examples")}
					title={t("codeMigration:config.examplesLabel")}
					tone="violet"
				>
					<div className="grid gap-2">
						{EXAMPLES.map(([key, stack]) => {
							const text = t(`codeMigration:examples.${key}`);
							return (
								<StepCard
									key={key}
									kicker={stack}
									title={text}
									tone="violet"
									active={migrationDescription === text}
									onClick={isRunning ? undefined : () => setMigrationDescription(text)}
								/>
							);
						})}
					</div>
				</Column>

				<Column kicker={t("codeMigration:kickers.analysis")} title={t(`codeMigration:phases.${phase}`)}>
					<div className="space-y-3">
						{!activeProject && (
							<Notice tone="amber" icon={AlertTriangle}>
								{t("codeMigration:errors.noProject")}
							</Notice>
						)}
						{created && (
							<Notice tone="green" icon={CheckCircle2}>
								{t("codeMigration:task.created", { title: created })}
							</Notice>
						)}
						{isRunning && <ScanLine label={status || t(`codeMigration:phases.${phase}`)} />}
						{error && (
							<Notice tone="red" icon={AlertTriangle} role="alert">
								{error}
							</Notice>
						)}
						{phase === "complete" && result ? (
							<>
								<Stats>
									<Stat label={t("codeMigration:results.source")} value={result.plan.source || "—"} tone="blue" />
									<Stat label={t("codeMigration:results.target")} value={result.plan.target || "—"} tone="violet" />
									<Stat
										label={t("codeMigration:results.planStatus")}
										value={t(`codeMigration:planStatus.${result.summary.plan_status}`, {
											defaultValue: result.summary.plan_status,
										})}
										tone={ready ? "green" : "amber"}
									/>
								</Stats>
								<Notice tone={ready ? "blue" : "amber"} icon={KanbanSquare}>
									{t(ready ? "codeMigration:results.readyHint" : "codeMigration:results.unsupportedHint")}
								</Notice>
							</>
						) : (
							!isRunning &&
							!error && (
								<EmptyStage icon={Download} tone="violet" title={t("codeMigration:empty.title")}>
									{t("codeMigration:empty.body")}
								</EmptyStage>
							)
						)}
						{streamingOutput && (
							<Panel>
								<details>
									<summary className="wp-meta cursor-pointer">{t("codeMigration:results.log")}</summary>
									<pre className="wp-code mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">
										{streamingOutput}
									</pre>
								</details>
							</Panel>
						)}
					</div>
				</Column>
			</Columns>

			<Composer
				prompt={
					<Textarea
						id="code-migration-description"
						value={migrationDescription}
						onChange={(e) => setMigrationDescription(e.target.value)}
						disabled={isRunning}
						rows={2}
						aria-label={t("codeMigration:config.descriptionLabel")}
						placeholder={t("codeMigration:config.descriptionPlaceholder")}
						className="min-h-0 w-full flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
					/>
				}
				actions={
					isRunning ? (
						<CharterButton variant="danger" icon={Square} onClick={cancelCodeMigration}>
							{t("codeMigration:actions.cancel")}
						</CharterButton>
					) : (
						<CharterButton
							icon={Search}
							onClick={() => activeProject?.path && startCodeMigration(activeProject.path)}
							disabled={!activeProject || !description}
						>
							{t("codeMigration:actions.analyze")}
						</CharterButton>
					)
				}
				hint={t("codeMigration:config.hint")}
			/>
		</ModuleStage>
	);
}

export default CodeMigrationDashboard;
