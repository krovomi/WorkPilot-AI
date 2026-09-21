/**
 * Tests de la bannière d'airgap.
 *
 * Ce qui est épinglé ici est ce que l'utilisateur peut faire : voir la cause,
 * voir le fichier, et lever le blocage sans quitter la page. Plus une absence
 * qui compte autant — pas de bouton quand le blocage vient d'un répertoire
 * parent, parce qu'il n'y ferait rien.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			typeof options?.error === "string" ? `${key}:${options.error}` : key,
	}),
}));

import type { AirgapStatus } from "../../../hooks/useAirgapStatus";
import { AirgapBanner } from "../AirgapBanner";

function status(overrides: Partial<AirgapStatus> = {}): AirgapStatus {
	return {
		airgapStrict: true,
		policyPath: "/repo/.workpilot/offline-mode.json",
		policyIsProjectOwn: true,
		loaded: true,
		refresh: vi.fn(),
		disableStrict: vi.fn().mockResolvedValue(null),
		...overrides,
	};
}

describe("AirgapBanner", () => {
	it("ne rend rien quand le projet n'est pas en airgap", () => {
		const { container } = render(
			<AirgapBanner
				status={status({ airgapStrict: false })}
				blockedLabel="blocked"
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("nomme le fichier qui décide et offre de lever le blocage", async () => {
		const disableStrict = vi.fn().mockResolvedValue(null);
		render(
			<AirgapBanner status={status({ disableStrict })} blockedLabel="blocked" />,
		);

		expect(
			screen.getByText("/repo/.workpilot/offline-mode.json"),
		).toBeInTheDocument();
		expect(screen.getByText("blocked")).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: /offlineMode:disableStrict/ }),
		);
		expect(disableStrict).toHaveBeenCalledOnce();
	});

	// `set-policy` n'écrit que sous le projet : un bouton ici créerait une
	// seconde politique pendant que celle du parent continuerait de bloquer.
	it("n'offre pas le bouton quand la politique vient d'un parent", () => {
		render(
			<AirgapBanner
				status={status({ policyIsProjectOwn: false })}
				blockedLabel="blocked"
			/>,
		);

		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByText("offlineMode:airgapInherited")).toBeInTheDocument();
	});

	it("affiche l'échec au lieu de laisser croire que c'est fait", async () => {
		const disableStrict = vi.fn().mockResolvedValue("read-only filesystem");
		render(
			<AirgapBanner status={status({ disableStrict })} blockedLabel="blocked" />,
		);

		await userEvent.click(screen.getByRole("button"));

		await waitFor(() =>
			expect(
				screen.getByText(
					"offlineMode:disableStrictFailed:read-only filesystem",
				),
			).toBeInTheDocument(),
		);
	});
});
