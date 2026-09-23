import {
	Brain,
	CircleAlert,
	CircleCheck,
	FolderOpen,
	GitBranch,
	RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrainStore } from "../../stores/brain-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/**
 * Le cerveau partagé dans les réglages : où il est, d'où il vient.
 *
 * Deux façons de le brancher, qui se combinent :
 *
 * - **un dossier** — un vault Obsidian existant est adopté tel quel (ses notes
 *   deviennent la mémoire des agents, rien n'est ajouté à sa racine), un
 *   dossier vide devient un nouveau cerveau ;
 * - **un dépôt git** — `utilisateur/dépôt` pour GitHub ou une URL : un dossier
 *   vide est cloné depuis lui, et chaque modification est ensuite tirée et
 *   poussée. C'est ce qui garde le même cerveau sur plusieurs machines.
 *
 * Le dossier est réglé par personne, pas par projet : c'est le même cerveau
 * pour tous les projets et tous les agents. Quand `WORKPILOT_BRAIN_DIR` est
 * défini, c'est lui qui décide et le champ est en lecture seule — un réglage
 * qui ne gagne pas ne doit pas avoir l'air de gagner.
 */
/** The backend answers with a code; the sentence is the UI's to write. */
const ERROR_KEYS: Record<string, string> = {
	"outside-home": "brain:settings.errors.outsideHome",
	"is-file": "brain:settings.errors.isFile",
	"invalid-remote": "brain:settings.errors.invalidRemote",
	"env-locked": "brain:settings.errors.envLocked",
	auth: "brain:settings.errors.auth",
	"not-found": "brain:settings.errors.notFound",
	network: "brain:settings.errors.network",
	timeout: "brain:settings.errors.timeout",
	"git-missing": "brain:settings.errors.gitMissing",
	failed: "brain:settings.errors.failed",
	"sync-failed": "brain:settings.errors.syncFailed",
	"invalid-path": "brain:settings.errors.invalidPath",
	"invalid-status": "brain:settings.errors.invalidStatus",
};

export function BrainSettings() {
	const { t } = useTranslation(["brain"]);
	const settings = useBrainStore((s) => s.settings);
	const unavailable = useBrainStore((s) => s.unavailable);
	const error = useBrainStore((s) => s.error);
	const saving = useBrainStore((s) => s.saving);
	const syncing = useBrainStore((s) => s.syncing);
	const lastSync = useBrainStore((s) => s.lastSync);
	const loadSettings = useBrainStore((s) => s.loadSettings);
	const saveSettings = useBrainStore((s) => s.saveSettings);
	const sync = useBrainStore((s) => s.sync);

	const errorText = (code: string) =>
		ERROR_KEYS[code]
			? t(ERROR_KEYS[code])
			: t("brain:settings.error", { error: code });

	const [path, setPath] = useState("");
	const [remote, setRemote] = useState("");
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		void loadSettings(true);
	}, [loadSettings]);

	useEffect(() => {
		if (!settings) return;
		setPath(settings.path);
		setRemote(settings.remote ?? "");
	}, [settings]);

	if (unavailable) {
		return (
			<section className="space-y-3 p-6">
				<h2 className="text-lg font-semibold">{t("brain:settings.title")}</h2>
				<p className="text-sm text-muted-foreground">
					{t("brain:settings.unavailable")}
				</p>
			</section>
		);
	}

	if (!settings) {
		return (
			<section className="space-y-3 p-6">
				<h2 className="text-lg font-semibold">{t("brain:settings.title")}</h2>
				<p className="text-sm text-muted-foreground" role="status">
					{error ? errorText(error) : t("brain:settings.loading")}
				</p>
			</section>
		);
	}

	const envLocked = settings.source === "env";
	const pathChanged = path.trim() !== settings.path;
	const remoteChanged = remote.trim() !== (settings.remote ?? "");

	const browse = async () => {
		const picked = await globalThis.electronAPI.selectDirectory();
		if (picked) setPath(picked);
	};

	const connect = async () => {
		setSaved(false);
		const ok = await saveSettings({
			...(envLocked ? {} : { path: path.trim() }),
			...(remote.trim() ? { remote: remote.trim() } : {}),
			connect: true,
		});
		setSaved(ok);
	};

	return (
		<section className="space-y-5 p-6">
			<div className="flex items-center gap-2">
				<Brain className="h-5 w-5 text-violet-500" aria-hidden />
				<h2 className="text-lg font-semibold">{t("brain:settings.title")}</h2>
			</div>
			<p className="text-sm text-muted-foreground">
				{t("brain:settings.description")}
			</p>

			<div className="flex items-center justify-between gap-4">
				<div>
					<span className="text-sm font-medium">{t("brain:settings.enabled")}</span>
					<p className="text-xs text-muted-foreground">
						{t("brain:settings.enabledHint")}
					</p>
				</div>
				<Switch
					checked={settings.enabled}
					disabled={saving}
					onCheckedChange={(checked) =>
						void saveSettings({ enabled: checked, connect: false })
					}
					aria-label={t("brain:settings.enabled")}
				/>
			</div>

			<div className="space-y-2">
				<label htmlFor="brain-path" className="text-sm font-medium">
					{t("brain:settings.folder")}
				</label>
				<div className="flex gap-2">
					<Input
						id="brain-path"
						value={path}
						disabled={envLocked || saving}
						onChange={(e) => setPath(e.target.value)}
						placeholder={settings.defaultPath}
					/>
					<Button
						variant="outline"
						disabled={envLocked || saving}
						onClick={() => void browse()}
					>
						<FolderOpen className="mr-1 h-4 w-4" aria-hidden />
						{t("brain:settings.browse")}
					</Button>
					<Button
						variant="ghost"
						disabled={envLocked || saving || path === settings.defaultPath}
						onClick={() => setPath(settings.defaultPath)}
					>
						{t("brain:settings.useDefault")}
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					{envLocked
						? t("brain:settings.envOverride", { variable: settings.envVariable })
						: t("brain:settings.folderHint")}
				</p>
			</div>

			<div className="space-y-2">
				<label htmlFor="brain-remote" className="text-sm font-medium">
					{t("brain:settings.remote")}
				</label>
				<Input
					id="brain-remote"
					value={remote}
					disabled={saving}
					onChange={(e) => setRemote(e.target.value)}
					placeholder={t("brain:settings.remotePlaceholder")}
				/>
				<p className="text-xs text-muted-foreground">
					{t("brain:settings.remoteHint")}
				</p>
			</div>

			<div className="flex flex-wrap gap-2">
				<Button
					disabled={
						saving ||
						(!pathChanged && !remoteChanged && settings.exists)
					}
					onClick={() => void connect()}
				>
					<GitBranch className="mr-1 h-4 w-4" aria-hidden />
					{saving ? t("brain:settings.connecting") : t("brain:settings.connect")}
				</Button>
				<Button
					variant="outline"
					disabled={syncing || !settings.exists || !settings.git}
					onClick={() => void sync()}
				>
					<RefreshCw
						className={`mr-1 h-4 w-4 ${syncing ? "animate-spin" : ""}`}
						aria-hidden
					/>
					{syncing ? t("brain:settings.syncing") : t("brain:settings.sync")}
				</Button>
			</div>

			{saved && !error && (
				<p className="text-sm text-emerald-600" role="status">
					{t("brain:settings.saved")}
				</p>
			)}
			{error && (
				<p className="text-sm text-destructive" role="alert">
					{errorText(error)}
				</p>
			)}
			{lastSync && !error && (
				<p className="text-xs text-muted-foreground" role="status">
					{lastSync.conflicts.length > 0
						? t("brain:settings.lastSync.conflicts", {
								count: lastSync.conflicts.length,
							})
						: lastSync.skipped
							? t("brain:settings.lastSync.skipped", {
									reason: lastSync.skipped,
								})
							: t("brain:settings.lastSync.ok")}
				</p>
			)}

			<div className="space-y-1 rounded-lg border p-3">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{t("brain:settings.status.title")}
				</h3>
				<StatusLine
					ok={settings.active}
					text={
						!settings.enabled
							? t("brain:settings.status.disabled")
							: settings.exists
								? t("brain:settings.status.active", { notes: settings.notes })
								: t("brain:settings.status.inactive")
					}
				/>
				{settings.obsidianVault && (
					<StatusLine ok text={t("brain:settings.status.obsidian")} />
				)}
				{!settings.gitAvailable ? (
					<StatusLine ok={false} text={t("brain:settings.status.noGit")} />
				) : (
					settings.exists && (
						<StatusLine
							ok={Boolean(settings.remote)}
							text={
								settings.remote
									? t("brain:settings.status.remote", { remote: settings.remote })
									: t("brain:settings.status.noRemote")
							}
						/>
					)
				)}
				{settings.proposals > 0 && (
					<StatusLine
						ok={false}
						text={t("brain:settings.status.proposals", {
							count: settings.proposals,
						})}
					/>
				)}
			</div>
		</section>
	);
}

function StatusLine({ ok, text }: { ok: boolean; text: string }) {
	return (
		<p className="flex items-start gap-2 text-xs text-muted-foreground">
			{ok ? (
				<CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
			) : (
				<CircleAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" aria-hidden />
			)}
			<span className="min-w-0 break-all">{text}</span>
		</p>
	);
}
