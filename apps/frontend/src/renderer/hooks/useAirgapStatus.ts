/**
 * Ce projet bloque-t-il les fournisseurs cloud ?
 *
 * La réponse vit dans `.workpilot/offline-mode.json` et gouverne *chaque*
 * appel du produit, mais elle n'était lisible que sur la page Mode hors-ligne,
 * sous la forme d'une case à cocher. Partout ailleurs — la liste « Fournisseur
 * IA », le Bounty Board, l'Arena — le fournisseur choisi s'affichait en vert et
 * le backend le refusait une seconde plus tard, en parlant d'un modèle local
 * que personne n'avait nommé.
 *
 * Le backend est la seule autorité (`core.offline_policy.airgap_status`, servi
 * par `offlineMode:status`) : il lit le fichier, remonte les répertoires
 * parents comme le fait la résolution réelle, et dit *quel* fichier décide.
 * Une seconde lecture en TypeScript répondrait à côté le jour où un projet
 * hérite de la politique d'un répertoire parent.
 */

import { useEffect, useState } from "react";

export interface AirgapStatus {
	/** Vrai seulement quand le backend l'a dit. Une lecture en échec n'alerte pas. */
	airgapStrict: boolean;
	/** Le fichier qui décide, tel que le backend l'a trouvé. */
	policyPath: string | null;
	loaded: boolean;
}

const UNKNOWN: AirgapStatus = {
	airgapStrict: false,
	policyPath: null,
	loaded: false,
};

export function useAirgapStatus(projectPath?: string): AirgapStatus {
	const [status, setStatus] = useState<AirgapStatus>(UNKNOWN);

	useEffect(() => {
		if (!projectPath) {
			setStatus(UNKNOWN);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result =
					await globalThis.electronAPI.getOfflineStatus(projectPath);
				if (cancelled) return;
				setStatus({
					airgapStrict: result?.airgapStrict === true,
					policyPath: result?.policyPath ?? null,
					loaded: true,
				});
			} catch {
				// Un backend qui démarre encore ne doit pas faire clignoter une
				// alerte d'airgap : l'absence de réponse n'est pas un airgap, et
				// c'est le refus côté backend qui tient la promesse de toute façon.
				if (!cancelled) setStatus(UNKNOWN);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [projectPath]);

	return status;
}
