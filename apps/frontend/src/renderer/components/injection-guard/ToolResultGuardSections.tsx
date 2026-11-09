import { Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolResultAlert } from "../../../shared/types/injection-guard";
import { formatAppDateTime } from "../../lib/date-format";
import { CharterButton, Chip, Notice, Panel, Section } from "../charter";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const KINDS = ["path", "host", "tool", "command"] as const;
type Kind = (typeof KINDS)[number];

interface Props {
	readonly projectPath: string;
}

/** What the agents read that the guard flagged, and the sources the person trusts (#388). */
export function ToolResultGuardSections({ projectPath }: Props): React.ReactElement {
	return (
		<>
			<ToolResultAlerts projectPath={projectPath} />
			<TrustedSources projectPath={projectPath} />
		</>
	);
}

function ToolResultAlerts({ projectPath }: Props): React.ReactElement {
	const { t } = useTranslation("injectionGuard");
	const [alerts, setAlerts] = useState<ToolResultAlert[] | null>(null);
	const [failed, setFailed] = useState(false);

	const load = useCallback(async () => {
		setFailed(false);
		try {
			setAlerts(await globalThis.electronAPI.getToolResultAlerts(projectPath));
		} catch {
			setFailed(true);
		}
	}, [projectPath]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<Section
			kicker={t("toolResults.kicker")}
			title={t("toolResults.title")}
			description={t("toolResults.description")}
			actions={
				<CharterButton variant="ghost" icon={RefreshCw} onClick={() => void load()}>
					{t("toolResults.refresh")}
				</CharterButton>
			}
		>
			{failed && (
				<Notice tone="red" role="alert">
					{t("toolResults.loadFailed")}
				</Notice>
			)}
			{alerts && alerts.length === 0 && (
				<p className="wp-muted text-xs" data-testid="tool-result-alerts-empty">
					{t("toolResults.empty")}
				</p>
			)}
			{alerts && alerts.length > 0 && (
				<ul className="grid gap-2" data-testid="tool-result-alerts">
					{alerts.map((alert) => (
						<li key={`${alert.spec}-${alert.at}-${alert.source}-${alert.tool}`}>
							<Panel rail tone={alert.level === "blocked" ? "red" : "amber"}>
								<div className="flex flex-wrap items-center gap-2">
									<Chip tone={alert.level === "blocked" ? "red" : "amber"}>
										{t(`threat.${alert.level}`)}
									</Chip>
									<Chip tone={alert.action === "withheld" ? "red" : "blue"} dot={false}>
										{t(`toolResults.action.${alert.action}`)}
									</Chip>
									<span className="wp-title min-w-0 flex-1 truncate font-mono text-xs" title={alert.source}>
										{alert.source}
									</span>
									<span className="wp-meta">{formatAppDateTime(alert.at)}</span>
								</div>
								<p className="wp-meta mt-1 truncate text-xs">
									{t("toolResults.where", { spec: alert.spec, tool: alert.tool })}
								</p>
								{alert.findings.length > 0 && (
									<p className="mt-1 text-xs">{alert.findings.join(" · ")}</p>
								)}
							</Panel>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

function TrustedSources({ projectPath }: Props): React.ReactElement {
	const { t } = useTranslation("injectionGuard");
	const [sources, setSources] = useState<string[]>([]);
	const [kind, setKind] = useState<Kind>("path");
	const [pattern, setPattern] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		globalThis.electronAPI
			.getTrustedSources(projectPath)
			.then(setSources)
			.catch(() => setSources([]));
	}, [projectPath]);

	const save = async (next: string[], added?: string) => {
		setError(null);
		try {
			const saved = await globalThis.electronAPI.setTrustedSources(projectPath, next);
			setSources(saved);
			if (added && !saved.includes(added)) setError(t("trusted.invalid"));
			else setPattern("");
		} catch {
			setError(t("trusted.saveFailed"));
		}
	};

	const add = () => {
		const entry = `${kind}:${pattern.trim()}`;
		if (!pattern.trim()) return;
		void save([...sources, entry], entry);
	};

	return (
		<Section
			kicker={t("trusted.kicker")}
			title={t("trusted.title")}
			description={t("trusted.description")}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Select value={kind} onValueChange={(value) => setKind(value as Kind)}>
					<SelectTrigger aria-label={t("trusted.kindLabel")} className="h-8 w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{KINDS.map((k) => (
							<SelectItem key={k} value={k}>
								{t(`trusted.kind.${k}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					aria-label={t("trusted.patternLabel")}
					className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
					placeholder={t(`trusted.placeholder.${kind}`)}
					value={pattern}
					onChange={(e) => setPattern(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") add();
					}}
				/>
				<CharterButton icon={Plus} onClick={add} disabled={!pattern.trim()}>
					{t("trusted.add")}
				</CharterButton>
			</div>
			{error && (
				<Notice tone="red" icon={ShieldAlert} role="alert" className="mt-2">
					{error}
				</Notice>
			)}
			{sources.length === 0 ? (
				<p className="wp-muted mt-2 text-xs">{t("trusted.empty")}</p>
			) : (
				<ul className="mt-2 grid gap-1.5" data-testid="trusted-sources">
					{sources.map((source) => (
						<li key={source} className="flex items-center gap-2 text-xs">
							<span className="min-w-0 flex-1 truncate font-mono">{source}</span>
							<CharterButton
								variant="ghost"
								icon={Trash2}
								aria-label={t("trusted.remove", { source })}
								onClick={() => void save(sources.filter((s) => s !== source))}
							/>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}
