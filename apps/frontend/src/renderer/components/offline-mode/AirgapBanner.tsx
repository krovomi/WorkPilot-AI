/**
 * L'avertissement d'airgap, et son interrupteur.
 *
 * Le message précédent décrivait la barrière puis envoyait son lecteur ailleurs
 * : « décochez Mode strict dans Réglages → Mode hors-ligne ». C'est une
 * instruction de navigation, pas une réponse — et elle demande d'aller
 * décocher, dans un autre écran, une case que personne n'avait cochée (le
 * défaut la portait cochée jusqu'à #220). L'interrupteur appartient à l'endroit
 * où la barrière se manifeste.
 *
 * Ce que le bouton ne fait pas : décider. Lever un airgap reste un geste
 * explicite, sur un clic, avec le fichier concerné écrit à l'écran. Une
 * migration qui l'aurait levé toute seule serait la même faute qu'à l'origine,
 * dans l'autre sens.
 *
 * Composant plutôt que bloc inline : le mode strict bloque le Kanban, l'Arena
 * et les Insights autant que le Bounty Board, et la deuxième surface qui en a
 * besoin ne doit pas le réécrire.
 */

import { ShieldOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AirgapStatus } from "../../hooks/useAirgapStatus";
import { Button } from "../ui/button";

interface Props {
	readonly status: AirgapStatus;
	/** Ce que la surface appelante ne peut pas faire tant que l'airgap tient. */
	readonly blockedLabel: string;
}

export function AirgapBanner({ status, blockedLabel }: Props) {
	const { t } = useTranslation(["offlineMode", "common"]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!status.airgapStrict) return null;

	const handleDisable = async () => {
		setBusy(true);
		setError(null);
		const failure = await status.disableStrict();
		setBusy(false);
		if (failure) setError(failure);
	};

	return (
		<div
			role="alert"
			className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
		>
			<p className="font-medium text-destructive">
				{t("offlineMode:airgapActive")}
			</p>
			<p className="mt-1 text-muted-foreground">{blockedLabel}</p>
			{status.policyPath && (
				<p className="mt-1 font-mono text-xs text-muted-foreground break-all">
					{status.policyPath}
				</p>
			)}

			{status.policyIsProjectOwn ? (
				<div className="mt-2 flex items-center gap-3">
					<Button
						size="sm"
						variant="outline"
						onClick={handleDisable}
						disabled={busy}
					>
						<ShieldOff className="w-3 h-3 mr-1" />
						{busy
							? t("offlineMode:disablingStrict")
							: t("offlineMode:disableStrict")}
					</Button>
					<span className="text-xs text-muted-foreground">
						{t("offlineMode:disableStrictHint")}
					</span>
				</div>
			) : (
				// L'airgap vient d'un répertoire parent : `set-policy` n'écrit que
				// sous ce projet, donc un bouton ici créerait une seconde politique
				// sans rien débloquer — la résolution est stricte dès qu'une seule
				// politique trouvée l'est.
				<p className="mt-2 text-xs text-muted-foreground">
					{t("offlineMode:airgapInherited")}
				</p>
			)}

			{error && (
				<p className="mt-2 text-xs text-destructive">
					{t("offlineMode:disableStrictFailed", { error })}
				</p>
			)}
		</div>
	);
}
