/**
 * #3.12 i18n Auto-Scaling panel.
 *
 * Two readings of one directory, behind a switch:
 *
 * * **Report** — coverage and the missing, obsolete and mismatched keys per
 *   locale. What is wrong.
 * * **Editor** — the keys themselves, editable, added and removed
 *   (`i18n-editor/`). Where it gets fixed.
 *
 * They share the directory and the source locale rather than each asking
 * again, because they are two questions about the same files.
 *
 * UX: the directory is picked via the native OS dialog (no manual typing of
 * paths), and in the editor the project's *own* translation directories are
 * detected and offered first — a native dialog walked down to
 * `apps/frontend/src/shared/i18n/locales` is a poor way to open the thing the
 * app already knows about. The source locale is a dropdown of common BCP-47
 * codes with an escape hatch for custom values like "pt-BR".
 */

import { FolderOpen, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useI18nEditorStore } from "../../stores/i18n-editor-store";
import { useI18nScalerStore } from "../../stores/phase35-stores";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";
import { TranslationEditor } from "./i18n-editor/TranslationEditor";

const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const PATH_MAX_LEN = 1024;

const COMMON_LOCALES = [
	"en",
	"fr",
	"es",
	"de",
	"it",
	"pt",
	"nl",
	"ru",
	"pl",
	"ja",
	"ko",
	"zh",
	"zh-CN",
	"zh-TW",
	"ar",
	"tr",
	"sv",
	"da",
	"no",
	"fi",
	"cs",
] as const;

const CUSTOM_SENTINEL = "__custom__";

interface I18nScalerPanelProps {
	/** The open project. Its own translation directories are offered below. */
	projectPath?: string;
}

export function I18nScalerPanel({ projectPath = "" }: I18nScalerPanelProps) {
	const { t } = useTranslation("phase35");
	const { phase, error, report, scannedDir, redirectedFrom, runReport } =
		useI18nScalerStore();
	const editor = useI18nEditorStore();
	const [mode, setMode] = useState<"report" | "editor">("report");
	const [dir, setDir] = useState("");
	const [source, setSource] = useState<string>("en");
	const [customSource, setCustomSource] = useState("");
	const [usingCustom, setUsingCustom] = useState(false);

	const isRunning = phase === "running";

	const effectiveSource = usingCustom ? customSource.trim() : source;

	const dirError = useMemo(() => {
		if (dir.trim().length === 0) return t("i18nScaler.validation.localesDirRequired");
		if (dir.length > PATH_MAX_LEN)
			return t("common.tooLong", { max: PATH_MAX_LEN });
		return null;
	}, [dir, t]);

	const sourceError = useMemo(() => {
		if (effectiveSource.length === 0)
			return t("i18nScaler.validation.sourceLocaleRequired");
		if (!LOCALE_PATTERN.test(effectiveSource))
			return t("i18nScaler.validation.sourceLocaleInvalid");
		return null;
	}, [effectiveSource, t]);

	const hasError = Boolean(dirError) || Boolean(sourceError);
	const editorBusy = editor.phase === "loading";

	// Asked once per project, and only in the editor: the report has always
	// been driven by an explicit directory, and a scan nobody asked for on the
	// way into a panel is a scan that surprises.
	const detectRoots = editor.detectRoots;
	useEffect(() => {
		if (mode === "editor" && projectPath) void detectRoots(projectPath);
	}, [mode, projectPath, detectRoots]);

	const handleBrowse = async () => {
		try {
			const picked = await globalThis.electronAPI.selectDirectory();
			if (picked) setDir(picked);
		} catch {
			// dialog dismissed or unavailable — leave state unchanged.
		}
	};

	const handleSourceChange = (value: string) => {
		if (value === CUSTOM_SENTINEL) {
			setUsingCustom(true);
			return;
		}
		setUsingCustom(false);
		setSource(value);
	};

	const cancelCustom = () => {
		setUsingCustom(false);
		setCustomSource("");
	};

	return (
		<PanelShell
			title={t("i18nScaler.title")}
			subtitle={t("i18nScaler.subtitle")}
			error={error}
			actions={
				<>
					{/*
					 * Two readings of the same directory: the report says what is
					 * wrong, the editor is where it gets fixed. They share the
					 * picker above rather than each asking for the path again.
					 */}
					<div className="flex rounded-md border p-0.5">
						{(["report", "editor"] as const).map((value) => (
							<Button
								key={value}
								size="sm"
								variant={mode === value ? "secondary" : "ghost"}
								className="h-6 px-2 text-[11px]"
								onClick={() => setMode(value)}
							>
								{t(`i18nScaler.mode.${value}`)}
							</Button>
						))}
					</div>
					<Button
						size="sm"
						onClick={() =>
							mode === "report"
								? runReport(dir.trim(), effectiveSource)
								: void editor.loadNamespaces(dir.trim(), effectiveSource)
						}
						disabled={isRunning || editorBusy || hasError}
					>
						{mode === "report"
							? isRunning
								? t("common.running")
								: t("i18nScaler.runReport")
							: editorBusy
								? t("common.loading")
								: t("i18nScaler.loadTranslations")}
					</Button>
				</>
			}
		>
			<div className="space-y-3 text-sm">
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label htmlFor="locales-dir-input" className="block font-medium mb-1">
							{t("i18nScaler.localesDir")}
						</label>
						<div className="flex items-center gap-1">
							<input
								id="locales-dir-input"
								value={dir}
								readOnly
								aria-invalid={Boolean(dirError) || undefined}
								aria-describedby={dirError ? "dir-error" : undefined}
								className="w-full rounded border bg-muted/30 p-2 font-mono text-xs"
								placeholder={t("i18nScaler.localesDirPlaceholder")}
								title={dir || undefined}
							/>
							{dir.length > 0 && (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => setDir("")}
									aria-label={t("i18nScaler.clearDir")}
								>
									<X className="h-3.5 w-3.5" />
								</Button>
							)}
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={handleBrowse}
							>
								<FolderOpen className="h-3.5 w-3.5 mr-1" />
								{t("i18nScaler.browseDir")}
							</Button>
						</div>
						{dirError && (
							<p id="dir-error" className="mt-1 text-xs text-destructive">
								{dirError}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="source-locale-select" className="block font-medium mb-1">
							{t("i18nScaler.sourceLocale")}
						</label>
						{usingCustom ? (
							<div className="space-y-1">
								<div className="flex items-center gap-1">
									<input
										value={customSource}
										onChange={(e) =>
											setCustomSource(e.target.value.slice(0, 12))
										}
										maxLength={12}
										aria-label={t("i18nScaler.sourceLocaleCustomLabel")}
										aria-invalid={Boolean(sourceError) || undefined}
										aria-describedby={sourceError ? "source-error" : undefined}
										placeholder={t("i18nScaler.sourceLocaleCustomPlaceholder")}
										className="w-full rounded border bg-background p-2 text-sm"
										// biome-ignore lint/a11y/noAutofocus: field is revealed by a user action, not focused on page load
										autoFocus
									/>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={cancelCustom}
										aria-label={t("common.clearAll")}
									>
										<X className="h-3.5 w-3.5" />
									</Button>
								</div>
							</div>
						) : (
							<select
								id="source-locale-select"
								value={source}
								onChange={(e) => handleSourceChange(e.target.value)}
								aria-invalid={Boolean(sourceError) || undefined}
								aria-describedby={sourceError ? "source-error" : undefined}
								className="w-full rounded border bg-background p-2 text-sm"
							>
								{COMMON_LOCALES.map((code) => (
									<option key={code} value={code}>
										{code}
									</option>
								))}
								<option value={CUSTOM_SENTINEL}>
									{t("i18nScaler.sourceLocaleCustom")}
								</option>
							</select>
						)}
						{sourceError && (
							<p id="source-error" className="mt-1 text-xs text-destructive">
								{sourceError}
							</p>
						)}
					</div>
				</div>

				{mode === "editor" && editor.detectedRoots.length > 0 && !editor.localesDir && (
					<div className="rounded border border-dashed p-3">
						<p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
							<Sparkles className="h-3.5 w-3.5 text-primary" />
							{t("i18nScaler.detectedTitle")}
						</p>
						<div className="flex flex-wrap gap-2">
							{editor.detectedRoots.map((root) => (
								<Button
									key={root.path}
									size="sm"
									variant="outline"
									className="h-auto flex-col items-start gap-0.5 px-2 py-1.5"
									onClick={() => {
										setDir(root.path);
										void editor.loadNamespaces(root.path, effectiveSource);
									}}
								>
									<span className="font-mono text-[11px]">{root.relative}</span>
									<span className="text-[10px] font-normal text-muted-foreground">
										{t("i18nScaler.detectedMeta", {
											locales: root.locales.join(", "),
											count: root.namespaces,
										})}
									</span>
								</Button>
							))}
						</div>
					</div>
				)}

				{mode === "editor" && (
					<div className="space-y-2">
						{editor.error && (
							<p className="text-xs text-destructive">{editor.error}</p>
						)}
						{editor.localesDir && (
							<p className="font-mono text-xs text-muted-foreground break-all">
								{t("i18nScaler.scannedDir", { dir: editor.localesDir })}
								{editor.locales.length > 0 && ` · ${editor.locales.join(", ")}`}
							</p>
						)}
						{editor.namespaces.length > 0 ? (
							<TranslationEditor />
						) : (
							<p className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
								{t("i18nScaler.editorEmpty")}
							</p>
						)}
					</div>
				)}

				{mode === "report" && report && scannedDir && (
					<p className="text-xs text-muted-foreground font-mono break-all">
						{redirectedFrom
							? t("i18nScaler.redirectedNotice", {
									picked: redirectedFrom,
									dir: scannedDir,
								})
							: t("i18nScaler.scannedDir", { dir: scannedDir })}
					</p>
				)}

				{mode === "report" && report && (
					<div className="space-y-3">
						<div>
							<div className="font-medium mb-1">{t("i18nScaler.coverage")}</div>
							<table className="w-full text-sm border">
								<thead>
									<tr className="border-b bg-muted/40">
										<th className="text-left p-2">{t("i18nScaler.colLocale")}</th>
										<th className="text-right p-2">{t("i18nScaler.colTranslated")}</th>
										<th className="text-right p-2">{t("i18nScaler.colPlaceholder")}</th>
										<th className="text-right p-2">{t("i18nScaler.colTotal")}</th>
										<th className="text-right p-2">{t("i18nScaler.colCoverage")}</th>
									</tr>
								</thead>
								<tbody>
									{report.coverage.map((c) => (
										<tr key={c.locale} className="border-b">
											<td className="p-2 font-mono">{c.locale}</td>
											<td className="p-2 text-right">{c.translated_keys}</td>
											<td className="p-2 text-right">{c.placeholder_keys}</td>
											<td className="p-2 text-right">{c.total_keys}</td>
											<td className="p-2 text-right">
												{(c.coverage_ratio * 100).toFixed(1)}%
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						{report.diffs.map((d) => (
							<details key={d.target_locale} className="rounded border p-2">
								<summary className="font-medium cursor-pointer">
									{d.target_locale} ({d.totals.missing} {t("i18nScaler.missing")},{" "}
									{d.totals.obsolete} {t("i18nScaler.obsolete")},{" "}
									{d.totals.placeholder_mismatches} {t("i18nScaler.mismatches")})
								</summary>
								<div className="mt-2 grid grid-cols-3 gap-3 text-xs">
									<div>
										<div className="font-medium">
											{t("i18nScaler.missingKeys")}
										</div>
										<ul className="font-mono max-h-32 overflow-auto">
											{d.missing_keys.map((k) => (
												<li key={k}>{k}</li>
											))}
										</ul>
									</div>
									<div>
										<div className="font-medium">
											{t("i18nScaler.obsoleteKeys")}
										</div>
										<ul className="font-mono max-h-32 overflow-auto">
											{d.obsolete_keys.map((k) => (
												<li key={k}>{k}</li>
											))}
										</ul>
									</div>
									<div>
										<div className="font-medium">
											{t("i18nScaler.placeholderMismatches")}
										</div>
										<ul className="font-mono max-h-32 overflow-auto">
											{d.placeholder_mismatches.map((k) => (
												<li key={k}>{k}</li>
											))}
										</ul>
									</div>
								</div>
							</details>
						))}
					</div>
				)}
			</div>
		</PanelShell>
	);
}
