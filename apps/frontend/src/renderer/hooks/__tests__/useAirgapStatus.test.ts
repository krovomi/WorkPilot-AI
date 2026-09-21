/**
 * Tests du lecteur d'état airgap.
 *
 * Les propriétés épinglées ici sont celles qui décident d'une alerte affichée à
 * l'utilisateur : le mode strict est signalé avec le fichier qui le porte, un
 * backend qui n'a pas répondu ne produit pas de fausse alerte (une absence de
 * réponse n'est pas un airgap), et changer de projet ne laisse pas l'alerte du
 * précédent à l'écran.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAirgapStatus } from "../useAirgapStatus";

const getOfflineStatus = vi.fn();
const getOfflinePolicy = vi.fn();
const setOfflinePolicy = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = {
		getOfflineStatus,
		getOfflinePolicy,
		setOfflinePolicy,
	};
});

describe("useAirgapStatus", () => {
	it("signale le mode strict et le fichier qui le porte", async () => {
		getOfflineStatus.mockResolvedValue({
			airgapStrict: true,
			policyPath: "/repo/.workpilot/offline-mode.json",
		});

		const { result } = renderHook(() => useAirgapStatus("/repo/project"));

		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current.airgapStrict).toBe(true);
		expect(result.current.policyPath).toBe(
			"/repo/.workpilot/offline-mode.json",
		);
		expect(getOfflineStatus).toHaveBeenCalledWith("/repo/project");
	});

	it("ne signale rien quand la politique n'est pas stricte", async () => {
		getOfflineStatus.mockResolvedValue({
			airgapStrict: false,
			policyPath: null,
		});

		const { result } = renderHook(() => useAirgapStatus("/repo/project"));

		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current.airgapStrict).toBe(false);
	});

	// Un backend qui démarre encore ferait clignoter une alerte d'airgap sur
	// tous les projets ; l'absence de réponse n'est pas un airgap, et c'est le
	// refus côté backend qui tient la promesse de toute façon.
	it("ne transforme pas un échec de lecture en alerte", async () => {
		getOfflineStatus.mockRejectedValue(new Error("backend not ready"));

		const { result } = renderHook(() => useAirgapStatus("/repo/project"));

		await waitFor(() => expect(getOfflineStatus).toHaveBeenCalled());
		expect(result.current.airgapStrict).toBe(false);
		expect(result.current.loaded).toBe(false);
	});

	// Un statut plus ancien répondant après un changement de projet afficherait
	// l'airgap du projet qu'on vient de quitter.
	it("ne demande rien sans projet, et oublie le précédent", async () => {
		getOfflineStatus.mockResolvedValue({
			airgapStrict: true,
			policyPath: "/repo/.workpilot/offline-mode.json",
		});

		const { result, rerender } = renderHook(
			({ path }: { path?: string }) => useAirgapStatus(path),
			{ initialProps: { path: "/repo/project" } as { path?: string } },
		);
		await waitFor(() => expect(result.current.airgapStrict).toBe(true));

		rerender({ path: undefined });

		expect(result.current.airgapStrict).toBe(false);
		expect(result.current.loaded).toBe(false);
		expect(getOfflineStatus).toHaveBeenCalledTimes(1);
	});

	it("rapporte si la politique qui décide appartient au projet", async () => {
		getOfflineStatus.mockResolvedValue({
			airgapStrict: true,
			policyPath: "/parent/.workpilot/offline-mode.json",
			policyIsProjectOwn: false,
		});

		const { result } = renderHook(() =>
			useAirgapStatus("/parent/sub/project"),
		);

		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current.airgapStrict).toBe(true);
		expect(result.current.policyIsProjectOwn).toBe(false);
	});
});

describe("useAirgapStatus().disableStrict", () => {
	// `_save_policy` n'accepte une politique dont le routage pointe vers un
	// modèle désinstallé que par sa porte `disabling_only` : la politique
	// précédente à l'identique, `airgapStrict` mis à false. Or c'est
	// exactement la politique qui piège l'utilisateur. Renvoyer un champ de
	// plus — un routage « corrigé », un `version` bumpé — ferait refuser
	// l'écriture, et le bouton ne ferait rien.
	it("renvoie la politique persistée avec le seul drapeau basculé", async () => {
		const saved = {
			version: 1,
			airgapStrict: true,
			defaultProvider: "ollama",
			routing: { coder: { provider: "ollama", model: "gone:70b" } },
			history: [],
		};
		getOfflineStatus.mockResolvedValue({
			airgapStrict: true,
			policyPath: "/repo/.workpilot/offline-mode.json",
			policyIsProjectOwn: true,
		});
		getOfflinePolicy.mockResolvedValue({ policy: saved, persisted: true });
		setOfflinePolicy.mockResolvedValue({ policy: saved });

		const { result } = renderHook(() => useAirgapStatus("/repo"));
		await waitFor(() => expect(result.current.loaded).toBe(true));

		const failure = await result.current.disableStrict();

		expect(failure).toBeNull();
		expect(setOfflinePolicy).toHaveBeenCalledWith("/repo", {
			...saved,
			airgapStrict: false,
		});
	});

	it("relit le statut après avoir levé le blocage", async () => {
		getOfflineStatus
			.mockResolvedValueOnce({ airgapStrict: true, policyIsProjectOwn: true })
			.mockResolvedValueOnce({ airgapStrict: false, policyIsProjectOwn: true });
		getOfflinePolicy.mockResolvedValue({ policy: { airgapStrict: true } });
		setOfflinePolicy.mockResolvedValue({});

		const { result } = renderHook(() => useAirgapStatus("/repo"));
		await waitFor(() => expect(result.current.airgapStrict).toBe(true));

		await result.current.disableStrict();

		await waitFor(() => expect(result.current.airgapStrict).toBe(false));
	});

	// Un bandeau ne doit pas faire tomber la page qu'il coiffe.
	it("rend l'échec plutôt que de le lever", async () => {
		getOfflineStatus.mockResolvedValue({
			airgapStrict: true,
			policyIsProjectOwn: true,
		});
		getOfflinePolicy.mockResolvedValue({ policy: { airgapStrict: true } });
		setOfflinePolicy.mockRejectedValue(new Error("read-only filesystem"));

		const { result } = renderHook(() => useAirgapStatus("/repo"));
		await waitFor(() => expect(result.current.loaded).toBe(true));

		await expect(result.current.disableStrict()).resolves.toBe(
			"read-only filesystem",
		);
	});
});
