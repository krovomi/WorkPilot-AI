import type { PluginType } from "@shared/types/plugin-marketplace";
import {
	ArrowLeft,
	ArrowRight,
	Bot,
	Check,
	Copy,
	FileCode,
	FolderOpen,
	MessageSquareText,
	Palette,
	Plug,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Textarea } from "../ui/textarea";

// ============================================
// Types
// ============================================

interface PluginFormData {
	type: PluginType | null;
	id: string;
	name: string;
	description: string;
	version: string;
	// Agent-specific
	systemPrompt: string;
	triggerKeywords: string;
	// Integration-specific
	authType: "none" | "apikey" | "oauth" | "basic";
	apiEndpoint: string;
	// Theme-specific
	primaryColor: string;
	backgroundColor: string;
	// Spec template / Custom prompt
	templateContent: string;
}

const INITIAL_FORM: PluginFormData = {
	type: null,
	id: "",
	name: "",
	description: "",
	version: "1.0.0",
	systemPrompt: "",
	triggerKeywords: "",
	authType: "none",
	apiEndpoint: "",
	primaryColor: "#8b5cf6",
	backgroundColor: "#0a0a1a",
	templateContent: "",
};

// ============================================
// Plugin type cards config
// ============================================

const PLUGIN_TYPE_OPTIONS: Array<{
	type: PluginType;
	icon: React.ElementType;
	color: string;
	labelKey: string;
	descKey: string;
}> = [
	{
		type: "agent",
		labelKey: "common:pluginMarketplace.types.agent",
		icon: Bot,
		color: "#8b5cf6",
		descKey: "common:pluginMarketplace.creator.typeDescAgent",
	},
	{
		type: "integration",
		labelKey: "common:pluginMarketplace.types.integration",
		icon: Plug,
		color: "#3b82f6",
		descKey: "common:pluginMarketplace.creator.typeDescIntegration",
	},
	{
		type: "spec-template",
		labelKey: "common:pluginMarketplace.types.specTemplate",
		icon: FileCode,
		color: "#10b981",
		descKey: "common:pluginMarketplace.creator.typeDescSpecTemplate",
	},
	{
		type: "theme",
		labelKey: "common:pluginMarketplace.types.theme",
		icon: Palette,
		color: "#f97316",
		descKey: "common:pluginMarketplace.creator.typeDescTheme",
	},
	{
		type: "custom-prompt",
		labelKey: "common:pluginMarketplace.types.customPrompt",
		icon: MessageSquareText,
		color: "#ec4899",
		descKey: "common:pluginMarketplace.creator.typeDescCustomPrompt",
	},
];

const PLUGIN_TYPES = Object.fromEntries(
	PLUGIN_TYPE_OPTIONS.map((option) => [option.type, option]),
) as Record<PluginType, (typeof PLUGIN_TYPE_OPTIONS)[number]>;

// ============================================
// Helpers
// ============================================

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** What the main process accepts as a plugin folder name: `my-plugin`. */
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The `plugin.config.json` that `pluginMarketplace:create` writes for `form`,
 * built with the same rules as the main process so the preview is the file.
 */
function generateConfigPreview(form: PluginFormData): string {
	const config: Record<string, unknown> = {
		id: form.id,
		name: form.name,
		type: form.type,
		version: form.version,
		description: form.description,
	};

	if (form.type === "agent") {
		config.systemPrompt = form.systemPrompt;
		if (form.triggerKeywords.trim()) {
			config.triggers = form.triggerKeywords
				.split(",")
				.map((k) => k.trim())
				.filter(Boolean);
		}
	} else if (form.type === "integration") {
		config.authType = form.authType;
		if (form.apiEndpoint) config.apiEndpoint = form.apiEndpoint;
	} else if (form.type === "theme") {
		config.themeData = {
			"--color-primary": form.primaryColor || INITIAL_FORM.primaryColor,
			"--color-background": form.backgroundColor || INITIAL_FORM.backgroundColor,
		};
	} else {
		config.content = form.templateContent;
	}

	return JSON.stringify(config, null, 2);
}

// ============================================
// Step components
// ============================================

function StepTypeSelection({
	selected,
	onSelect,
	t,
}: {
	selected: PluginType | null;
	onSelect: (type: PluginType) => void;
	t: (key: string) => string;
}) {
	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				{t("common:pluginMarketplace.creator.selectTypeDesc")}
			</p>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				{PLUGIN_TYPE_OPTIONS.map(({ type, icon: Icon, color, labelKey, descKey }) => (
					<button
						key={type}
						type="button"
						aria-pressed={selected === type}
						onClick={() => onSelect(type)}
						className={cn(
							"flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all",
							selected === type
								? "border-primary bg-primary/5 ring-1 ring-primary/20"
								: "border-border hover:border-primary/40 hover:bg-accent/50",
						)}
					>
						<div
							className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
							style={{ backgroundColor: `${color}20` }}
						>
							<Icon className="h-5 w-5" style={{ color }} />
						</div>
						<div className="min-w-0">
							<p className="text-sm font-semibold">{t(labelKey)}</p>
							<p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
								{t(descKey)}
							</p>
						</div>
						{selected === type && (
							<Check className="h-4 w-4 text-primary shrink-0 mt-0.5 ml-auto" />
						)}
					</button>
				))}
			</div>
		</div>
	);
}

function StepDetails({
	form,
	onChange,
	t,
}: {
	form: PluginFormData;
	onChange: (updates: Partial<PluginFormData>) => void;
	t: (key: string) => string;
}) {
	const fieldId = useId();
	const idOf = (field: string) => `${fieldId}-${field}`;
	const idInvalid = form.id !== "" && !PLUGIN_ID_PATTERN.test(form.id);
	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				{t("common:pluginMarketplace.creator.detailsDesc")}
			</p>

			{/* Name → auto-generates id */}
			<div className="space-y-1.5">
								<label htmlFor={idOf("name")} className="text-xs font-medium">
					{t("common:pluginMarketplace.creator.fieldName")}
				</label>
				<Input
					id={idOf("name")}
					type="text"
					value={form.name}
					onChange={(e) =>
						onChange({ name: e.target.value, id: slugify(e.target.value) })
					}
					placeholder={t("common:pluginMarketplace.creator.namePlaceholder")}
					className="w-full px-3 py-2 text-sm h-auto"
				/>
			</div>

			<div className="space-y-1.5">
								<label htmlFor={idOf("id")} className="text-xs font-medium">
					{t("common:pluginMarketplace.creator.fieldId")}
				</label>
				<Input
					id={idOf("id")}
					aria-invalid={idInvalid}
					aria-describedby={idOf("idHint")}
					spellCheck={false}
					type="text"
					value={form.id}
					onChange={(e) => onChange({ id: e.target.value })}
					placeholder="my-awesome-plugin"
					className="w-full px-3 py-2 text-sm font-mono h-auto"
				/>
				<p
					id={idOf("idHint")}
					className={cn(
						"text-3xs",
						idInvalid ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{idInvalid
						? t("common:pluginMarketplace.creator.fieldIdInvalid")
						: t("common:pluginMarketplace.creator.fieldIdHint")}
				</p>
			</div>

			<div className="space-y-1.5">
								<label htmlFor={idOf("description")} className="text-xs font-medium">
					{t("common:pluginMarketplace.creator.fieldDescription")}
				</label>
				<Textarea
					id={idOf("description")}
					value={form.description}
					onChange={(e) => onChange({ description: e.target.value })}
					placeholder={t(
						"common:pluginMarketplace.creator.fieldDescriptionPlaceholder",
					)}
					rows={2}
					className="w-full px-3 py-2 text-sm resize-none min-h-0"
				/>
			</div>

			<div className="space-y-1.5">
								<label htmlFor={idOf("version")} className="text-xs font-medium">
					{t("common:pluginMarketplace.creator.fieldVersion")}
				</label>
				<Input
					id={idOf("version")}
					spellCheck={false}
					type="text"
					value={form.version}
					onChange={(e) => onChange({ version: e.target.value })}
					placeholder="1.0.0"
					className="w-48 px-3 py-2 text-sm font-mono h-auto"
				/>
			</div>

			{/* Type-specific fields */}
			{form.type === "agent" && (
				<>
					<div className="space-y-1.5">
												<label htmlFor={idOf("systemPrompt")} className="text-xs font-medium">
							{t("common:pluginMarketplace.creator.fieldSystemPrompt")}
						</label>
						<Textarea
							id={idOf("systemPrompt")}
							value={form.systemPrompt}
							onChange={(e) => onChange({ systemPrompt: e.target.value })}
							placeholder={t(
								"common:pluginMarketplace.creator.fieldSystemPromptPlaceholder",
							)}
							rows={4}
							className="w-full px-3 py-2 text-sm resize-none min-h-0"
						/>
					</div>
					<div className="space-y-1.5">
												<label htmlFor={idOf("triggers")} className="text-xs font-medium">
							{t("common:pluginMarketplace.creator.fieldTriggers")}
						</label>
						<Input
							id={idOf("triggers")}
							type="text"
							value={form.triggerKeywords}
							onChange={(e) => onChange({ triggerKeywords: e.target.value })}
							placeholder={t(
								"common:pluginMarketplace.creator.fieldTriggersPlaceholder",
							)}
							className="w-full px-3 py-2 text-sm h-auto"
						/>
						<p className="text-3xs text-muted-foreground">
							{t("common:pluginMarketplace.creator.fieldTriggersHint")}
						</p>
					</div>
				</>
			)}

			{form.type === "integration" && (
				<>
					<div className="space-y-1.5">
												<label htmlFor={idOf("authType")} className="text-xs font-medium">
							{t("common:pluginMarketplace.creator.fieldAuthType")}
						</label>
						<NativeSelect
							id={idOf("authType")}
							value={form.authType}
							onChange={(e) =>
								onChange({
									authType: e.target.value as PluginFormData["authType"],
								})
							}
							className="w-full px-3 py-2 text-sm h-auto"
						>
							<option value="none">
								{t("common:pluginMarketplace.creator.authNone")}
							</option>
							<option value="apikey">
								{t("common:pluginMarketplace.creator.authApiKey")}
							</option>
							<option value="oauth">OAuth</option>
							<option value="basic">
								{t("common:pluginMarketplace.creator.authBasic")}
							</option>
						</NativeSelect>
					</div>
					<div className="space-y-1.5">
												<label htmlFor={idOf("apiEndpoint")} className="text-xs font-medium">
							{t("common:pluginMarketplace.creator.fieldApiEndpoint")}
						</label>
						<Input
							id={idOf("apiEndpoint")}
							spellCheck={false}
							type="text"
							value={form.apiEndpoint}
							onChange={(e) => onChange({ apiEndpoint: e.target.value })}
							placeholder="https://api.example.com"
							className="w-full px-3 py-2 text-sm font-mono h-auto"
						/>
					</div>
				</>
			)}

			{form.type === "theme" && (
				<div className="grid grid-cols-2 gap-3">
					<div className="space-y-1.5">
												<label htmlFor={idOf("primaryColor")} className="text-xs font-medium">
							{t("common:pluginMarketplace.creator.fieldPrimaryColor")}
						</label>
						<div className="flex items-center gap-2">
							<input
								type="color"
								aria-label={t("common:pluginMarketplace.creator.fieldPrimaryColor")}
								value={form.primaryColor}
								onChange={(e) => onChange({ primaryColor: e.target.value })}
								className="h-8 w-8 rounded border border-border cursor-pointer"
							/>
							<Input
								id={idOf("primaryColor")}
								spellCheck={false}
								type="text"
								value={form.primaryColor}
								onChange={(e) => onChange({ primaryColor: e.target.value })}
								className="flex-1 px-3 py-2 text-sm font-mono h-auto"
							/>
						</div>
					</div>
					<div className="space-y-1.5">
												<label htmlFor={idOf("backgroundColor")} className="text-xs font-medium">
							{t("common:pluginMarketplace.creator.fieldBackgroundColor")}
						</label>
						<div className="flex items-center gap-2">
							<input
								type="color"
								aria-label={t("common:pluginMarketplace.creator.fieldBackgroundColor")}
								value={form.backgroundColor}
								onChange={(e) => onChange({ backgroundColor: e.target.value })}
								className="h-8 w-8 rounded border border-border cursor-pointer"
							/>
							<Input
								id={idOf("backgroundColor")}
								spellCheck={false}
								type="text"
								value={form.backgroundColor}
								onChange={(e) => onChange({ backgroundColor: e.target.value })}
								className="flex-1 px-3 py-2 text-sm font-mono h-auto"
							/>
						</div>
					</div>
				</div>
			)}

			{(form.type === "spec-template" || form.type === "custom-prompt") && (
				<div className="space-y-1.5">
										<label htmlFor={idOf("content")} className="text-xs font-medium">
						{form.type === "spec-template"
							? t("common:pluginMarketplace.creator.fieldTemplateContent")
							: t("common:pluginMarketplace.creator.fieldPromptContent")}
					</label>
					<Textarea
						id={idOf("content")}
						spellCheck={false}
						value={form.templateContent}
						onChange={(e) => onChange({ templateContent: e.target.value })}
						placeholder={
							form.type === "spec-template"
								? t(
										"common:pluginMarketplace.creator.fieldTemplateContentPlaceholder",
									)
								: t(
										"common:pluginMarketplace.creator.fieldSystemPromptPlaceholder",
									)
						}
						rows={6}
						className="w-full px-3 py-2 text-sm font-mono resize-none min-h-0"
					/>
				</div>
			)}
		</div>
	);
}

function StepPreview({
	form,
	type,
	onCopy,
	copied,
	t,
}: {
	form: PluginFormData;
	/** `form.type`, chosen on the first step */
	type: PluginType;
	onCopy: () => void;
	copied: boolean;
	t: (key: string) => string;
}) {
	const configPreview = generateConfigPreview(form);
	const option = PLUGIN_TYPES[type];

	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				{t("common:pluginMarketplace.creator.previewDesc")}
			</p>

			{/* Summary */}
			<div className="rounded-xl border border-border bg-card p-4 space-y-2">
				<div className="flex items-center gap-2">
					<div
						className="h-3 w-3 rounded-full"
						style={{
							backgroundColor: option.color,
						}}
					/>
					<span className="text-sm font-semibold">
						{form.name}
					</span>
					<span className="text-xs font-mono text-muted-foreground ml-auto">
						v{form.version}
					</span>
				</div>
				<p className="text-xs text-muted-foreground">
					{form.description || "—"}
				</p>
				<div className="flex items-center gap-2 text-3xs text-muted-foreground">
					<span className="bg-muted/60 px-1.5 py-0.5 rounded">
						{t(option.labelKey)}
					</span>
					<span className="font-mono bg-muted/60 px-1.5 py-0.5 rounded">
						{form.id}
					</span>
				</div>
			</div>

			{/* Generated config */}
			<p className="text-3xs text-muted-foreground">
				{t("common:pluginMarketplace.creator.configFile")}
			</p>
			<div className="relative">
				<button
					type="button"
					onClick={onCopy}
					className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-muted/80 px-2 py-1 text-3xs font-medium hover:bg-muted transition-colors"
				>
					{copied ? (
						<Check className="h-3 w-3" />
					) : (
						<Copy className="h-3 w-3" />
					)}
					{copied
						? t("common:pluginMarketplace.creator.copied")
						: t("common:pluginMarketplace.creator.copyConfig")}
				</button>
				<pre
					className={cn(
						"rounded-lg bg-muted/60 p-3 pt-8 text-xs font-mono overflow-x-auto",
						"border border-border/50 text-foreground/80 leading-relaxed",
					)}
				>
					{configPreview}
				</pre>
			</div>
		</div>
	);
}

// ============================================
// Main wizard
// ============================================

interface PluginCreatorWizardProps {
	onClose: () => void;
}

export function PluginCreatorWizard({ onClose }: PluginCreatorWizardProps) {
	const { t } = useTranslation(["common"]);
	const [step, setStep] = useState(0);
	const [form, setForm] = useState<PluginFormData>({ ...INITIAL_FORM });
	const [copied, setCopied] = useState(false);
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState(false);
	const [createdPath, setCreatedPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (copiedTimer.current) clearTimeout(copiedTimer.current);
		},
		[],
	);

	const STEPS = [
		{ labelKey: "common:pluginMarketplace.creator.stepType" },
		{ labelKey: "common:pluginMarketplace.creator.stepDetails" },
		{ labelKey: "common:pluginMarketplace.creator.stepPreview" },
	];

	const updateForm = useCallback((updates: Partial<PluginFormData>) => {
		setForm((prev) => ({ ...prev, ...updates }));
	}, []);

	const canAdvance =
		step === 0
			? form.type !== null
			: form.name.trim() !== "" && PLUGIN_ID_PATTERN.test(form.id);

	const goToStep = (next: number) => {
		setError(null);
		setStep(next);
	};

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(generateConfigPreview(form));
		} catch {
			setError(t("common:pluginMarketplace.creator.copyFailed"));
			return;
		}
		setError(null);
		setCopied(true);
		if (copiedTimer.current) clearTimeout(copiedTimer.current);
		copiedTimer.current = setTimeout(() => setCopied(false), 2000);
	}, [form, t]);

	const handleCreate = useCallback(async () => {
		setCreating(true);
		setError(null);
		try {
			const result = await globalThis.electronAPI?.invoke(
				"pluginMarketplace:create",
				{
					type: form.type,
					id: form.id,
					name: form.name,
					description: form.description,
					version: form.version,
					systemPrompt: form.systemPrompt,
					triggerKeywords: form.triggerKeywords,
					authType: form.authType,
					apiEndpoint: form.apiEndpoint,
					primaryColor: form.primaryColor,
					backgroundColor: form.backgroundColor,
					templateContent: form.templateContent,
				},
			);
			if (result?.success) {
				setCreated(true);
				setCreatedPath(result.data?.path || null);
			} else {
				setError(
					result?.error || t("common:pluginMarketplace.creator.createFailed"),
				);
			}
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: t("common:pluginMarketplace.creator.createFailed"),
			);
		} finally {
			setCreating(false);
		}
	}, [form, t]);

	/** Only offered once the plugin is created, with the folder it was written to. */
	const handleOpenFolder = useCallback(
		async (folder: string) => {
			setError(null);
			try {
				const result = await globalThis.electronAPI?.invoke(
					"pluginMarketplace:openLocalFolder",
					folder,
				);
				if (result?.success) return;
				setError(
					result?.error ||
						t("common:pluginMarketplace.creator.openFolderFailed"),
				);
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: t("common:pluginMarketplace.creator.openFolderFailed"),
				);
			}
		},
		[t],
	);

	return (
		<div className="flex flex-col h-full overflow-y-auto">
			{/* Header */}
			<div className="shrink-0 border-b border-border bg-gradient-to-b from-primary/5 to-transparent px-6 py-5">
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={onClose}
						aria-label={t("common:buttons.close")}
						title={t("common:buttons.close")}
						className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-accent transition-colors"
					>
						<ArrowLeft className="h-4 w-4" />
					</button>
					<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
						<Sparkles className="h-5 w-5 text-primary" />
					</div>
					<div>
						<h2 className="text-lg font-bold">
							{t("common:pluginMarketplace.creator.title")}
						</h2>
						<p className="text-xs text-muted-foreground">
							{t("common:pluginMarketplace.creator.subtitle")}
						</p>
					</div>
				</div>

				{/* Step indicator */}
				{!created && (
					<div className="flex items-center gap-2 mt-4">
						{STEPS.map((s, i) => (
							<div key={s.labelKey} className="flex items-center gap-2">
								<button
									type="button"
									onClick={() => i < step && goToStep(i)}
									disabled={i > step}
									aria-current={i === step ? "step" : undefined}
									className={cn(
										"flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
										i === step
											? "bg-primary text-primary-foreground"
											: i < step
												? "bg-primary/10 text-primary cursor-pointer hover:bg-primary/20"
												: "bg-muted text-muted-foreground",
									)}
								>
									<span className="flex h-4 w-4 items-center justify-center rounded-full text-3xs">
										{i < step ? <Check className="h-3 w-3" /> : i + 1}
									</span>
									{t(s.labelKey)}
								</button>
								{i < STEPS.length - 1 && (
									<div
										className={cn(
											"h-px w-6",
											i < step ? "bg-primary/40" : "bg-border",
										)}
									/>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			{/* Content */}
			<div className="flex-1 px-6 py-6 max-w-2xl">
				{created ? (
					<div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
						<div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10">
							<Check className="h-8 w-8 text-success" />
						</div>
						<h3 className="text-lg font-bold">
							{t("common:pluginMarketplace.creator.successTitle")}
						</h3>
						<p className="text-sm text-muted-foreground max-w-md">
							{t("common:pluginMarketplace.creator.successDesc", {
								name: form.name,
							})}
						</p>
						{createdPath && (
							<p className="text-xs font-mono text-muted-foreground bg-muted/60 px-3 py-1.5 rounded-lg">
								{createdPath}
							</p>
						)}
						{error && <p className="text-xs text-destructive">{error}</p>}
						<div className="flex gap-3 mt-4">
							{createdPath && (
								<button
									type="button"
									onClick={() => handleOpenFolder(createdPath)}
									className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-xs font-medium hover:bg-accent transition-colors"
								>
									<FolderOpen className="h-3.5 w-3.5" />
									{t("common:pluginMarketplace.creator.openFolder")}
								</button>
							)}
							<button
								type="button"
								onClick={onClose}
								className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
							>
								{t("common:pluginMarketplace.creator.done")}
							</button>
						</div>
					</div>
				) : (
					<>
						{step === 0 && (
							<StepTypeSelection
								selected={form.type}
								onSelect={(type) => updateForm({ type })}
								t={t}
							/>
						)}
						{step === 1 && (
							<StepDetails form={form} onChange={updateForm} t={t} />
						)}
						{step === 2 && form.type !== null && (
							<StepPreview
								form={form}
								type={form.type}
								onCopy={handleCopy}
								copied={copied}
								t={t}
							/>
						)}
					</>
				)}
			</div>

			{/* Footer with navigation */}
			{!created && (
				<div className="shrink-0 border-t border-border px-6 py-3 flex items-center justify-between">
					<button
						type="button"
						onClick={() => (step === 0 ? onClose() : goToStep(step - 1))}
						className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-xs font-medium hover:bg-accent transition-colors"
					>
						<ArrowLeft className="h-3.5 w-3.5" />
						{step === 0
							? t("common:pluginMarketplace.creator.cancel")
							: t("common:pluginMarketplace.creator.back")}
					</button>

					{error && <p className="text-xs text-destructive">{error}</p>}

					{step < STEPS.length - 1 ? (
						<button
							type="button"
							onClick={() => goToStep(step + 1)}
							disabled={!canAdvance}
							className={cn(
								"inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors",
								canAdvance
									? "bg-primary text-primary-foreground hover:bg-primary/90"
									: "bg-muted text-muted-foreground cursor-not-allowed",
							)}
						>
							{t("common:pluginMarketplace.creator.next")}
							<ArrowRight className="h-3.5 w-3.5" />
						</button>
					) : (
						<button
							type="button"
							onClick={handleCreate}
							disabled={creating}
							className="inline-flex items-center gap-1.5 rounded-md bg-success px-4 py-2 text-xs font-medium text-success-foreground hover:bg-success/90 transition-colors disabled:opacity-50"
						>
							{creating ? (
								<>
									<div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
									{t("common:pluginMarketplace.creator.creating")}
								</>
							) : (
								<>
									<Sparkles className="h-3.5 w-3.5" />
									{t("common:pluginMarketplace.creator.createPlugin")}
								</>
							)}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
