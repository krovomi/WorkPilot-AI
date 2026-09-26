/**
 * Where the model list came from, said in words the user can act on.
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

import type { ProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { ModelCatalogStatus } from "../ModelCatalogStatus";

function catalog(patch: Partial<ProviderModelCatalog>): ProviderModelCatalog {
	return {
		models: [],
		source: "live",
		fetchedAt: null,
		error: null,
		loading: false,
		refresh: vi.fn(),
		...patch,
	};
}

describe("ModelCatalogStatus", () => {
	it("names the public registry and explains why it answered", () => {
		const { container } = render(
			<ModelCatalogStatus catalog={catalog({ source: "registry" })} />,
		);
		expect(screen.getByText("common:modelCatalog.registry")).toBeTruthy();
		expect(container.firstElementChild?.getAttribute("title")).toBe(
			"common:modelCatalog.registryHint",
		);
	});

	it("dates a cached answer", () => {
		const fetchedAt = Date.now() / 1000 - 2 * 3600;
		render(
			<ModelCatalogStatus catalog={catalog({ source: "cache", fetchedAt })} />,
		);
		expect(
			screen.getByText(/^common:modelCatalog\.cache:.*hoursAgo/),
		).toBeTruthy();
	});

	it("refreshes on demand", () => {
		const refresh = vi.fn();
		render(<ModelCatalogStatus catalog={catalog({ refresh })} />);
		fireEvent.click(screen.getByLabelText("common:modelCatalog.refresh"));
		expect(refresh).toHaveBeenCalledOnce();
	});
});
