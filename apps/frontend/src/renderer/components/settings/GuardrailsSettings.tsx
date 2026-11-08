import { AlertTriangle, Check, FlaskConical, Plus, Save, ShieldHalf, Trash2, X } from "lucide-react";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	GuardrailAction,
	GuardrailRuleDoc,
} from "../../../preload/api/modules/guardrails-api";
import { useGuardrailsStore } from "../../stores/guardrails-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	Section,
	Tabs,
	type Tone,
} from "../charter";
import "../charter/charter.css";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./SettingsSection";

const ACTIONS: GuardrailAction[] = ["allow", "warn", "deny", "require_approval"];

const ACTION_TONES: Record<GuardrailAction, Tone> = {
	allow: "green",
	warn: "amber",
	deny: "red",
	require_approval: "violet",
};

const TOOLS = ["Write", "Edit", "Bash"] as const;
type TestTool = (typeof TOOLS)[number];

/** The guardrails page of the toolbox: the rules and the tester, on a stage. */
export function GuardrailsView(): React.ReactElement {
	const { t } = useTranslation(["settings", "navigation", "common"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const { doc, dirty, loading, addRule, save } = useGuardrailsStore();
	const projectPath = activeProject?.path;

	return (
		<ModuleStage scroll="page" data-testid="guardrails-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("settings:guardrails.title")}
				description={t("settings:guardrails.description")}
				icon={ShieldHalf}
				tone="red"
				actions={
					projectPath && (
						<>
							<Chip tone="red" dot={false}>
								{t("settings:guardrails.activeCount", { count: doc.rules.length })}
							</Chip>
							<CharterButton variant="ghost" icon={Plus} onClick={addRule}>
								{t("settings:guardrails.addRule")}
							</CharterButton>
							<CharterButton
								variant="primary"
								icon={Save}
								onClick={() => save(projectPath)}
								disabled={!dirty || loading}
							>
								{t("common:save")}
							</CharterButton>
						</>
					)
				}
			/>
			<Page className="max-w-none space-y-4">
				{projectPath ? (
					<GuardrailsEditor projectPath={projectPath} />
				) : (
					<EmptyStage icon={ShieldHalf} tone="red" title={t("settings:guardrails.title")}>
						{t("settings:guardrails.selectProject")}
					</EmptyStage>
				)}
			</Page>
		</ModuleStage>
	);
}

/** The same editor inside the Settings dialog. */
export function GuardrailsSettings(): React.ReactElement {
	const { t } = useTranslation(["settings", "common"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const { dirty, loading, addRule, save } = useGuardrailsStore();
	const projectPath = activeProject?.path;

	return (
		<SettingsSection
			title={t("settings:guardrails.title")}
			description={t(
				projectPath ? "settings:guardrails.description" : "settings:guardrails.selectProject",
			)}
		>
			{projectPath && (
				<div className="wp-scope space-y-4">
					<div className="flex justify-end gap-2">
						<CharterButton variant="ghost" icon={Plus} onClick={addRule}>
							{t("settings:guardrails.addRule")}
						</CharterButton>
						<CharterButton
							variant="primary"
							icon={Save}
							onClick={() => save(projectPath)}
							disabled={!dirty || loading}
						>
							{t("common:save")}
						</CharterButton>
					</div>
					<GuardrailsEditor projectPath={projectPath} />
				</div>
			)}
		</SettingsSection>
	);
}

function GuardrailsEditor({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t } = useTranslation("settings");
	const { doc, error, load, addRule, updateRule, deleteRule } = useGuardrailsStore();
	// Rules have no stable identity (their id is editable): each card keeps a
	// key of its own, so deleting a rule never hands its inputs to the next one.
	const keys = useRef<number[]>([]);
	const nextKey = useRef(0);
	while (keys.current.length < doc.rules.length) keys.current.push(nextKey.current++);
	keys.current.length = doc.rules.length;

	useEffect(() => {
		load(projectPath);
	}, [projectPath, load]);

	return (
		<>
			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{error}
				</Notice>
			)}
			<Section kicker={t("guardrails.kickers.rules")} title={t("guardrails.rulesTitle")}>
				{doc.rules.length === 0 ? (
					<EmptyStage
						icon={ShieldHalf}
						tone="red"
						title={t("guardrails.emptyTitle")}
						action={
							<CharterButton variant="primary" icon={Plus} onClick={addRule}>
								{t("guardrails.addRule")}
							</CharterButton>
						}
					>
						{t("guardrails.empty")}
					</EmptyStage>
				) : (
					<div className="grid gap-3 xl:grid-cols-2">
						{doc.rules.map((rule, idx) => (
							<RuleCard
								key={keys.current[idx]}
								rule={rule}
								onChange={(patch) => updateRule(idx, patch)}
								onDelete={() => {
									keys.current.splice(idx, 1);
									deleteRule(idx);
								}}
							/>
						))}
					</div>
				)}
			</Section>
			<Tester projectPath={projectPath} />
		</>
	);
}

function RuleCard({
	rule,
	onChange,
	onDelete,
}: {
	readonly rule: GuardrailRuleDoc;
	readonly onChange: (patch: Partial<GuardrailRuleDoc>) => void;
	readonly onDelete: () => void;
}): React.ReactElement {
	const { t } = useTranslation("settings");
	const uid = useId();
	const tone = ACTION_TONES[rule.action] ?? "muted";
	const tools = Array.isArray(rule.when.tool) ? rule.when.tool.join(", ") : (rule.when.tool ?? "");
	const text = (key: keyof GuardrailRuleDoc["when"], label: string, placeholder: string) => (
		<div className="space-y-1">
			<label className="wp-kicker block" htmlFor={`${uid}-${key}`}>
				{label}
			</label>
			<Input
				id={`${uid}-${key}`}
				className="h-8 font-mono text-xs"
				value={String(rule.when[key] ?? "")}
				onChange={(e) => onChange({ when: { [key]: e.target.value || undefined } })}
				placeholder={placeholder}
			/>
		</div>
	);

	return (
		<Panel rail tone={tone} className="space-y-3">
			<div className="flex items-center gap-2">
				<Input
					aria-label={t("guardrails.ruleId")}
					className="h-8 flex-1 font-mono text-xs"
					value={rule.id}
					onChange={(e) => onChange({ id: e.target.value })}
					placeholder={t("guardrails.ruleId")}
				/>
				<CharterButton
					variant="ghost"
					size="sm"
					icon={Trash2}
					onClick={onDelete}
					aria-label={t("guardrails.deleteRule")}
					title={t("guardrails.deleteRule")}
				/>
			</div>
			<div className="wp-chips">
				{ACTIONS.map((a) => (
					<Chip key={a} tone={ACTION_TONES[a]} pressed={rule.action === a} onClick={() => onChange({ action: a })}>
						{t(`guardrails.actions.${a}`)}
					</Chip>
				))}
			</div>
			<Input
				aria-label={t("guardrails.description_placeholder")}
				className="h-8 text-sm"
				value={rule.description}
				onChange={(e) => onChange({ description: e.target.value })}
				placeholder={t("guardrails.description_placeholder")}
			/>
			<div className="grid gap-2 sm:grid-cols-2">
				<div className="space-y-1">
					<label className="wp-kicker block" htmlFor={`${uid}-tool`}>
						{t("guardrails.tool")}
					</label>
					<Input
						id={`${uid}-tool`}
						className="h-8 font-mono text-xs"
						value={tools}
						onChange={(e) =>
							onChange({
								when: {
									tool: e.target.value
										.split(",")
										.map((s) => s.trim())
										.filter(Boolean),
								},
							})
						}
						placeholder="Write, Edit, Bash"
					/>
				</div>
				{text("path_prefix", t("guardrails.pathPrefix"), "migrations/")}
				{text("path_regex", t("guardrails.pathRegex"), "\\.sql$")}
				{text("content_regex", t("guardrails.contentRegex"), "TODO|FIXME")}
				<div className="space-y-1">
					<label className="wp-kicker block" htmlFor={`${uid}-lines`}>
						{t("guardrails.maxLines")}
					</label>
					<Input
						id={`${uid}-lines`}
						type="number"
						className="h-8 font-mono text-xs"
						value={rule.when.content_max_lines ?? ""}
						onChange={(e) =>
							onChange({
								when: { content_max_lines: e.target.value ? Number(e.target.value) : undefined },
							})
						}
						placeholder="500"
					/>
				</div>
				{text("command_pattern", t("guardrails.commandPattern"), "git push.*--force")}
			</div>
		</Panel>
	);
}

function Tester({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t } = useTranslation("settings");
	const { lastTest, runTest, reset } = useGuardrailsStore();
	const [tool, setTool] = useState<TestTool>("Write");
	const [path, setPath] = useState("");
	const [content, setContent] = useState("");
	const [command, setCommand] = useState("");

	const handleTest = () => {
		const input: Record<string, unknown> =
			tool === "Bash" ? { command } : { file_path: path, content };
		runTest(projectPath, tool, input);
	};
	const verdictTone: Tone = lastTest ? ACTION_TONES[lastTest.action] : "muted";

	return (
		<Section
			kicker={t("guardrails.kickers.tester")}
			title={t("guardrails.tester")}
			description={t("guardrails.testerHint")}
		>
			<Panel className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Tabs
						label={t("guardrails.tool")}
						tabs={TOOLS.map((id) => ({ id, label: id }))}
						value={tool}
						onChange={setTool}
					/>
					<CharterButton variant="primary" icon={FlaskConical} onClick={handleTest}>
						{t("guardrails.runTest")}
					</CharterButton>
				</div>
				{tool === "Bash" ? (
					<Input
						aria-label={t("guardrails.commandPattern")}
						className="h-8 font-mono text-xs"
						value={command}
						onChange={(e) => setCommand(e.target.value)}
						placeholder="git push --force origin main"
					/>
				) : (
					<>
						<Input
							aria-label={t("guardrails.filePath")}
							className="h-8 font-mono text-xs"
							value={path}
							onChange={(e) => setPath(e.target.value)}
							placeholder="migrations/001.sql"
						/>
						<Textarea
							aria-label={t("guardrails.fileContentPlaceholder")}
							spellCheck={false}
							className="min-h-20 w-full font-mono text-xs"
							value={content}
							onChange={(e) => setContent(e.target.value)}
							placeholder={t("guardrails.fileContentPlaceholder")}
						/>
					</>
				)}
				{lastTest && (
					<Notice tone={verdictTone} icon={lastTest.action === "allow" ? Check : X} role="status">
						<div className="flex items-start gap-2">
							<div className="min-w-0 flex-1">
								<b>{t(`guardrails.actions.${lastTest.action}`)}</b>
								{lastTest.triggered.length > 0 && (
									<span className="wp-meta ml-2 font-mono">{lastTest.triggered.join(", ")}</span>
								)}
								{lastTest.message && <p className="mt-1 whitespace-pre-wrap text-xs">{lastTest.message}</p>}
							</div>
							<CharterButton
								variant="ghost"
								size="sm"
								icon={X}
								onClick={reset}
								aria-label={t("guardrails.clearTest")}
								title={t("guardrails.clearTest")}
							/>
						</div>
					</Notice>
				)}
			</Panel>
		</Section>
	);
}
