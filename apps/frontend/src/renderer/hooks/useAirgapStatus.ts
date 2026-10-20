/**
 * Ce projet bloque-t-il les fournisseurs cloud — et peut-on le débloquer d'ici ?
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { OfflinePolicy } from "../../preload/api/modules/offline-mode-api";

export interface AirgapStatus {
	/** Vrai seulement quand le backend l'a dit. Une lecture en échec n'alerte pas. */
	airgapStrict: boolean;
	/** Le fichier qui décide, tel que le backend l'a trouvé. */
	policyPath: string | null;
	/**
	 * Le fichier qui décide appartient-il à ce projet ? Faux quand l'airgap est
	 * hérité d'un répertoire parent — auquel cas il ne se lève pas d'ici.
	 */
	policyIsProjectOwn: boolean;
	loaded: boolean;
	/** Relit le statut. Appelé après une désactivation. */
	refresh: () => void;
	/**
	 * Lève le mode strict, et rien d'autre.
	 *
	 * La politique persistée est renvoyée **telle quelle**, `airgapStrict` mis
	 * à false et pas un champ de plus : c'est la seule forme que `_save_policy`
	 * accepte sans revalider le routage (`disabling_only`). Cela compte
	 * précisément ici — la politique qui piège l'utilisateur route vers un
	 * modèle qui n'est plus installé, donc toute écriture qui prétendrait la
	 * « corriger » au passage serait refusée, et le bouton ne ferait rien.
	 *
	 * Rend une erreur plutôt que de la lever : un bandeau ne doit pas faire
	 * tomber la page qu'il coiffe.
	 */
	disableStrict: () => Promise<string | null>;
}

const UNKNOWN = {
	airgapStrict: false,
	policyPath: null as string | null,
	policyIsProjectOwn: false,
	loaded: false,
};

export function useAirgapStatus(projectPath?: string): AirgapStatus {
	const [status, setStatus] = useState(UNKNOWN);
	// Un jeton par lecture plutôt qu'un drapeau `cancelled` par effet : une
	// réponse partie pour le projet précédent peut revenir après celle du
	// nouveau, et seule la lecture la plus récente a le droit d'écrire.
	const latest = useRef(0);

	const load = useCallback(async (path: string) => {
		const ticket = ++latest.current;
		try {
			const result = await globalThis.electronAPI.getOfflineStatus(path);
			if (latest.current !== ticket) return;
			setStatus({
				airgapStrict: result?.airgapStrict === true,
				policyPath: result?.policyPath ?? null,
				policyIsProjectOwn: result?.policyIsProjectOwn === true,
				loaded: true,
			});
		} catch {
			// Un backend qui démarre encore ne doit pas faire clignoter une
			// alerte d'airgap : l'absence de réponse n'est pas un airgap, et
			// c'est le refus côté backend qui tient la promesse de toute façon.
			if (latest.current === ticket) setStatus(UNKNOWN);
		}
	}, []);

	useEffect(() => {
		if (!projectPath) {
			latest.current++;
			setStatus(UNKNOWN);
			return;
		}
		void load(projectPath);
	}, [projectPath, load]);

	const refresh = useCallback(() => {
		if (projectPath) void load(projectPath);
	}, [projectPath, load]);

	const disableStrict = useCallback(async (): Promise<string | null> => {
		if (!projectPath) return "no project";
		try {
			const { policy } = await globalThis.electronAPI.getOfflinePolicy(
				projectPath,
			);
			const relaxed: OfflinePolicy = { ...policy, airgapStrict: false };
			await globalThis.electronAPI.setOfflinePolicy(projectPath, relaxed);
			refresh();
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}, [projectPath, refresh]);

	return { ...status, refresh, disableStrict };
}
