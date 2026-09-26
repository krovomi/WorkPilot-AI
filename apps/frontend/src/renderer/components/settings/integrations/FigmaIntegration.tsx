import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";

interface FigmaIntegrationProps {
	readonly projectId: string;
}

/**
 * Le jeton Figma du projet.
 *
 * Le champ est en écriture seule : le processus principal l'écrit dans
 * `.workpilot/.env`, et ne renvoie jamais que « configuré ou non ». Le
 * backend s'en sert quand une personne lie une maquette à une tâche, pour lire
 * ses frames et ses textes par l'API plutôt que par l'OCR d'un export.
 */
export function FigmaIntegration({ projectId }: FigmaIntegrationProps) {
	const { t } = useTranslation("settings");
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [fromEnvironment, setFromEnvironment] = useState(false);
	const [token, setToken] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const result = await globalThis.electronAPI?.getFigmaTokenStatus?.(projectId);
		if (result?.success && result.data) {
			setConfigured(result.data.configured);
			setFromEnvironment(result.data.fromEnvironment);
		}
	}, [projectId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const save = async (value: string) => {
		setSaving(true);
		setError(null);
		const result = await globalThis.electronAPI?.setFigmaToken?.(projectId, value);
		setSaving(false);
		if (!result?.success) {
			setError(
				result?.error === "invalid-token"
					? t("integrations.figma.invalidToken")
					: t("integrations.figma.saveFailed"),
			);
			return;
		}
		setToken("");
		await refresh();
	};

	return (
		<div className="space-y-4">
			<p className="text-xs text-muted-foreground">
				{t("integrations.figma.description")}
			</p>
			<div className="flex items-center gap-2 text-sm">
				{configured ? (
					<>
						<CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
						<span>
							{fromEnvironment
								? t("integrations.figma.fromEnvironment")
								: t("integrations.figma.configured")}
						</span>
					</>
				) : (
					<>
						<KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
						<span className="text-muted-foreground">
							{t("integrations.figma.notConfigured")}
						</span>
					</>
				)}
			</div>
			<div className="space-y-2">
				<Label htmlFor="figma-token" className="font-normal text-foreground">
					{t("integrations.figma.tokenLabel")}
				</Label>
				<div className="flex gap-2">
					<Input
						id="figma-token"
						type="password"
						autoComplete="off"
						value={token}
						placeholder={t("integrations.figma.tokenPlaceholder")}
						onChange={(e) => setToken(e.target.value)}
					/>
					<Button
						size="sm"
						disabled={saving || token.trim() === ""}
						onClick={() => void save(token)}
					>
						{saving ? (
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
						) : (
							t("integrations.figma.save")
						)}
					</Button>
					{configured && !fromEnvironment && (
						<Button
							size="sm"
							variant="outline"
							disabled={saving}
							onClick={() => void save("")}
						>
							{t("integrations.figma.remove")}
						</Button>
					)}
				</div>
				<p className="text-xs text-muted-foreground">
					{t("integrations.figma.tokenHint")}
				</p>
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
		</div>
	);
}
