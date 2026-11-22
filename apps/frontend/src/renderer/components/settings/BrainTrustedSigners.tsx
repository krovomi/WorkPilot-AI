import { AlertTriangle, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type BrainVaultSigners,
	fetchBrainVaultSigners,
	saveBrainVaultSigners,
} from "../../lib/agent-tools-api";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const ERRORS: Record<string, string> = {
	invalid: "brain:settings.signers.invalid",
	"no-brain": "brain:settings.signers.noBrain",
};

/**
 * The vault's trusted signers (`brain/lifecycle/signers.py`, `VAULT_LIST`):
 * the keys whose signed commits let a note outside every project — shared
 * knowledge, instructions, skills — reach the agents. A project's notes have
 * the list of its Lifecycle tab. The vault has no maintainers, so whoever
 * edits the brain's settings here edits the list; a teammate's machine counts
 * a change only when a key already on it signed it. Shown once the backend
 * answers, so an older one shows nothing of it.
 */
export function BrainTrustedSigners() {
	const { t } = useTranslation(["brain"]);
	const [view, setView] = useState<BrainVaultSigners | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async (signal?: AbortSignal) => {
		const res = await fetchBrainVaultSigners(signal);
		if (!signal?.aborted && res.ok) setView(res.data);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	if (view === null) return null;

	const save = async (text: string) => {
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		setSaving(true);
		const res = await saveBrainVaultSigners(lines);
		setSaving(false);
		if (res.ok) {
			setView(res.data);
			setDraft(null);
			setError(null);
		} else {
			setError(t(ERRORS[res.error] ?? "brain:settings.signers.failed"));
		}
	};

	// The keys themselves are not shown back: a name and its kind say which key.
	const names = view.signers.map((s) => `${s.name} (${s.kind})`).join(", ");

	return (
		<div className="space-y-2 rounded-lg border p-3 text-xs text-muted-foreground">
			<div className="flex flex-wrap items-center gap-2">
				<KeyRound className="h-3.5 w-3.5" />
				<span className="text-sm font-medium text-foreground">
					{t("brain:settings.signers.title")}
				</span>
			</div>
			<p>{t("brain:settings.signers.hint")}</p>
			<div className="flex flex-wrap items-center gap-2">
				<span>
					{view.signers.length > 0
						? t("brain:settings.signers.list", { names })
						: t("brain:settings.signers.none")}
				</span>
				{draft === null && (
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs"
						onClick={() => setDraft("")}
					>
						{t("brain:settings.signers.edit")}
					</Button>
				)}
			</div>
			{view.signers.length > 0 && view.unverified > 0 && (
				<p>{t("brain:settings.signers.unverified", { count: view.unverified })}</p>
			)}
			{view.rejected > 0 && (
				<p className="flex items-center gap-2 text-warning">
					<AlertTriangle className="h-3.5 w-3.5" />
					{t("brain:settings.signers.rejected", { count: view.rejected })}
				</p>
			)}
			{view.signers.length > 0 && !view.signing && (
				<p className="text-warning">{t("brain:settings.signers.notSigning")}</p>
			)}
			{draft !== null && (
				<div className="space-y-2">
					<Textarea
						value={draft}
						rows={4}
						className="font-mono text-xs"
						placeholder={t("brain:settings.signers.placeholder")}
						aria-label={t("brain:settings.signers.placeholder")}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<div className="flex gap-2">
						<Button size="sm" disabled={saving} onClick={() => void save(draft)}>
							{t("brain:settings.signers.save")}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
							{t("brain:settings.signers.cancel")}
						</Button>
					</div>
				</div>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
