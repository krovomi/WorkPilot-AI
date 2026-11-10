/**
 * The personal style profile of the coach (#376): what the person's commits
 * in this project say about their style, per language, what they set by hand,
 * and whether the agents are given it. A task waiting for review can be
 * checked against it before the person reads the diff.
 */
import { Download, FileCheck2, RefreshCw, Upload, UserRoundPen } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type CoachCheckResult,
	type CoachProfileState,
	STYLE_DIMENSIONS,
	type StyleDimension,
	type StyleEntry,
	type StyleLanguage,
	type StyleOverrides,
} from "../../../shared/types/agent-coach";
import { useTaskStore } from "../../stores/task-store";
import { CharterButton, Chip, Notice, Section, Stat, Stats, type Tone } from "../charter";

type Busy = "load" | "build" | "save" | "export" | "import" | "check";

const SOURCE_TONE: Record<StyleEntry["source"], Tone> = { history: "green", project: "blue", lint: "violet" };
const DIMENSIONS = Object.keys(STYLE_DIMENSIONS) as StyleDimension[];

interface CoachProfilePanelProps {
	readonly projectPath?: string;
}

export function CoachProfilePanel({ projectPath }: CoachProfilePanelProps): React.ReactElement | null {
	const { t } = useTranslation("agentCoach");
	const tasks = useTaskStore((s) => s.tasks);
	const [state, setState] = useState<CoachProfileState | null>(null);
	const [busy, setBusy] = useState<Busy | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [exported, setExported] = useState<string | null>(null);
	const [spec, setSpec] = useState("");
	const [check, setCheck] = useState<CoachCheckResult | null>(null);

	const reviewable = tasks.filter((task) => task.status === "human_review" && task.specId);

	useEffect(() => {
		if (!projectPath) return;
		let alive = true;
		setBusy("load");
		Promise.resolve()
			.then(() => globalThis.electronAPI.getCoachProfile({ projectPath }))
			.then((next) => alive && setState(next))
			.catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
			.finally(() => alive && setBusy(null));
		return () => {
			alive = false;
		};
	}, [projectPath]);

	if (!projectPath) return null;

	const run = async (kind: Busy, call: () => Promise<CoachProfileState | null>) => {
		setBusy(kind);
		setError(null);
		try {
			const next = await call();
			if (next) setState(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const preferences = state?.preferences ?? { enabled: true, overrides: {} };
	const save = (enabled: boolean, overrides: StyleOverrides) =>
		void run("save", () => globalThis.electronAPI.setCoachPreferences({ projectPath, preferences: { enabled, overrides } }));

	const override = (language: StyleLanguage, dimension: StyleDimension, value: string) => {
		const overrides: StyleOverrides = { ...preferences.overrides, [language]: { ...preferences.overrides[language] } };
		const dims = overrides[language] ?? {};
		if (value === "auto") delete dims[dimension];
		else dims[dimension] = value;
		if (Object.keys(dims).length === 0) delete overrides[language];
		save(preferences.enabled, overrides);
	};

	const exportProfile = async () => {
		setBusy("export");
		setError(null);
		try {
			setExported(await globalThis.electronAPI.exportCoachProfile({ projectPath }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const checkTask = async () => {
		if (!spec) return;
		setBusy("check");
		setError(null);
		try {
			setCheck(await globalThis.electronAPI.checkCoachTask({ projectPath, spec }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const profile = state?.profile ?? null;
	const languages = new Set<StyleLanguage>([
		...(Object.keys(profile?.languages ?? {}) as StyleLanguage[]),
		...(Object.keys(preferences.overrides) as StyleLanguage[]),
	]);

	return (
		<Section
			kicker={t("profile.kicker")}
			title={t("profile.title")}
			tone="green"
			actions={
				<CharterButton
					size="sm"
					icon={RefreshCw}
					busy={busy === "build"}
					disabled={busy !== null}
					onClick={() => void run("build", () => globalThis.electronAPI.buildCoachProfile({ projectPath }))}
				>
					{t(profile ? "profile.rebuild" : "profile.build")}
				</CharterButton>
			}
		>
			<div className="space-y-3 text-xs">
				<p className="wp-muted">{t("profile.intro")}</p>
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={preferences.enabled}
						disabled={busy !== null}
						onChange={(event) => save(event.target.checked, preferences.overrides)}
					/>
					<span>{t("profile.enabled")}</span>
				</label>
				{state && (
					<p className={state.injected ? "wp-tone-green wp-ink" : "wp-faint"}>
						{t(state.injected ? "profile.injected" : "profile.notInjected")}
					</p>
				)}
				{profile && !profile.hasEmail && (
					<Notice tone="amber" icon={UserRoundPen}>
						{t("profile.noEmail")}
					</Notice>
				)}
				{profile && (
					<>
						<Stats>
							<Stat label={t("profile.commits.gold")} value={profile.commits.gold} tone="green" />
							<Stat label={t("profile.commits.accepted")} value={profile.commits.accepted} tone="blue" />
							<Stat label={t("profile.commits.corrected")} value={profile.commits.corrected} tone="amber" />
							<Stat label={t("profile.commits.team")} value={profile.commits.team} tone="violet" />
						</Stats>
						<p className="wp-meta">
							{t("profile.keptAsIs", {
								with: profile.metrics.withCoach.rate ?? "—",
								withCount: profile.metrics.withCoach.merged,
								without: profile.metrics.withoutCoach.rate ?? "—",
								withoutCount: profile.metrics.withoutCoach.merged,
							})}
						</p>
						{profile.lint.length > 0 && (
							<p className="wp-faint">
								{t("profile.lint")} <code className="font-mono">{profile.lint.join(", ")}</code>
							</p>
						)}
					</>
				)}
				{!profile && busy !== "load" && <p className="wp-faint">{t("profile.empty")}</p>}
				{[...languages].sort().map((language) => (
					<div key={language} className="space-y-1">
						<p className="wp-kicker">{t(`profile.languages.${language}`, { defaultValue: language })}</p>
						<ul className="grid gap-1">
							{DIMENSIONS.filter(
								(dim) => profile?.languages[language]?.[dim] || preferences.overrides[language]?.[dim],
							).map((dim) => {
								const entry = profile?.languages[language]?.[dim];
								const manual = preferences.overrides[language]?.[dim];
								return (
									<li key={dim} className="flex flex-wrap items-center gap-2">
										<span className="min-w-36">{t(`profile.dimensions.${dim}`)}</span>
										{entry && (
											<Chip tone={entry.state === "preferred" ? SOURCE_TONE[entry.source] : "muted"} dot={false}>
												{entry.state === "preferred"
													? t(`profile.values.${dim}.${entry.value}`)
													: t("profile.indifferent")}
											</Chip>
										)}
										{entry && (
											<span className="wp-faint">
												{t("profile.evidence", {
													share: Math.round(entry.share * 100),
													source: t(`profile.sources.${entry.source}`),
												})}
											</span>
										)}
										<select
											className="rounded border border-border bg-transparent px-1 py-0.5"
											aria-label={t("profile.override", { dimension: t(`profile.dimensions.${dim}`) })}
											value={manual ?? "auto"}
											disabled={busy !== null}
											onChange={(event) => override(language, dim, event.target.value)}
										>
											<option value="auto">{t("profile.auto")}</option>
											{STYLE_DIMENSIONS[dim].map((value) => (
												<option key={value} value={value}>
													{t(`profile.values.${dim}.${value}`)}
												</option>
											))}
											<option value="off">{t("profile.off")}</option>
										</select>
									</li>
								);
							})}
						</ul>
					</div>
				))}
				<div className="flex flex-wrap gap-2">
					<CharterButton
						size="sm"
						variant="ghost"
						icon={Download}
						busy={busy === "export"}
						disabled={busy !== null || Object.keys(state?.effective ?? {}).length === 0}
						onClick={() => void exportProfile()}
					>
						{t("profile.export")}
					</CharterButton>
					<CharterButton
						size="sm"
						variant="ghost"
						icon={Upload}
						busy={busy === "import"}
						disabled={busy !== null}
						onClick={() => void run("import", () => globalThis.electronAPI.importCoachProfile({ projectPath }))}
					>
						{t("profile.import")}
					</CharterButton>
				</div>
				{exported && <p className="wp-faint">{t("profile.exported", { path: exported })}</p>}
				{reviewable.length > 0 && Object.keys(state?.effective ?? {}).length > 0 && (
					<div className="space-y-1.5 border-t border-border/50 pt-2">
						<p className="wp-kicker">{t("profile.check.title")}</p>
						<div className="flex flex-wrap items-center gap-2">
							<select
								className="rounded border border-border bg-transparent px-1 py-0.5"
								aria-label={t("profile.check.task")}
								value={spec}
								onChange={(event) => {
									setSpec(event.target.value);
									setCheck(null);
								}}
							>
								<option value="">{t("profile.check.choose")}</option>
								{reviewable.map((task) => (
									<option key={task.specId} value={task.specId}>
										{task.title || task.specId}
									</option>
								))}
							</select>
							<CharterButton
								size="sm"
								icon={FileCheck2}
								busy={busy === "check"}
								disabled={busy !== null || !spec}
								onClick={() => void checkTask()}
							>
								{t("profile.check.run")}
							</CharterButton>
						</div>
						{check && check.deviations.length === 0 && (
							<p className="wp-tone-green wp-ink">{t("profile.check.none")}</p>
						)}
						{check && check.deviations.length > 0 && (
							<ul className="grid gap-1">
								{check.deviations.map((d) => (
									<li key={`${d.language}-${d.dimension}`}>
										{t("profile.check.deviation", {
											language: t(`profile.languages.${d.language}`, { defaultValue: d.language }),
											dimension: t(`profile.dimensions.${d.dimension}`),
											found: t(`profile.values.${d.dimension}.${d.found}`),
											expected: t(`profile.values.${d.dimension}.${d.expected}`),
											count: d.count,
										})}
									</li>
								))}
							</ul>
						)}
					</div>
				)}
				{error && (
					<Notice tone="red" role="alert">
						{error}
					</Notice>
				)}
			</div>
		</Section>
	);
}
