import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogModel } from "../../../hooks/useProviderModelCatalog";
import {
	catalogEntry,
	contextLabel,
	filterCatalog,
	formatPerMillion,
	indexCatalog,
	priceLabel,
} from "../gateway-model-catalog";
import { GatewayModelCatalog } from "../GatewayModelCatalog";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) =>
			opts && Object.keys(opts).length ? `${key}:${JSON.stringify(opts)}` : key,
	}),
}));

const catalog = vi.hoisted(() => ({
	value: {
		models: [] as CatalogModel[],
		source: "live" as string,
		loading: false,
	},
}));
vi.mock("../../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: () => ({ ...catalog.value, refresh: () => {} }),
}));

const kimi: CatalogModel = {
	value: "moonshotai/Kimi-K3.1-Pro",
	label: "moonshotai/Kimi-K3.1-Pro",
	inputPrice: 0.2403,
	outputPrice: 8.4023,
	contextWindow: 262144,
	providerCount: 3,
};
const glm: CatalogModel = {
	value: "zai-org/GLM-5.3-Flash",
	label: "zai-org/GLM-5.3-Flash",
	inputPrice: 0,
	outputPrice: null,
};

describe("gateway catalogue helpers", () => {
	it("finds a Hub repo whatever its case or routing suffix", () => {
		const index = indexCatalog([kimi, { value: "custom", label: "Custom" }]);
		expect(catalogEntry(index, "MoonshotAI/kimi-k3.1-pro")).toBe(kimi);
		expect(catalogEntry(index, "moonshotai/Kimi-K3.1-Pro:fastest")).toBe(kimi);
		expect(catalogEntry(index, "custom")).toBeUndefined();
		expect(catalogEntry(index, "org/unknown")).toBeUndefined();
	});

	it("reads a price per million tokens", () => {
		expect(formatPerMillion(0.2403)).toBe("$0.24");
		expect(formatPerMillion(8.4023)).toBe("$8.4");
		expect(formatPerMillion(12.34)).toBe("$12.3");
		expect(formatPerMillion(0.0399)).toBe("$0.04");
		expect(formatPerMillion(0.004)).toBe("$0.004");
		expect(formatPerMillion(0)).toBe("$0");
		expect(formatPerMillion(-1)).toBeNull();
		expect(formatPerMillion(null)).toBeNull();
		expect(formatPerMillion(Number.NaN)).toBeNull();
		expect(priceLabel(kimi)).toBe("$0.24 / $8.4");
		expect(priceLabel(glm)).toBe("$0 / ?");
		expect(priceLabel({ value: "a/b", label: "a/b" })).toBeNull();
		expect(priceLabel(undefined)).toBeNull();
	});

	it("reads a context window", () => {
		expect(contextLabel(262144)).toBe("262k");
		expect(contextLabel(1_048_576)).toBe("1M");
		expect(contextLabel(2_500_000)).toBe("2.5M");
		expect(contextLabel(0)).toBeNull();
		expect(contextLabel(null)).toBeNull();
	});

	it("keeps the entries that hold every word of the filter", () => {
		const models = [kimi, glm, { value: "custom", label: "Custom" }];
		expect(filterCatalog(models, "")).toEqual([kimi, glm]);
		expect(filterCatalog(models, " kimi  PRO ")).toEqual([kimi]);
		expect(filterCatalog(models, "kimi flash")).toEqual([]);
	});
});

describe("GatewayModelCatalog", () => {
	beforeEach(() => {
		catalog.value = { models: [kimi, glm], source: "live", loading: false };
	});

	it("lists the served models with their price and makes one the default", () => {
		const onSelect = vi.fn();
		render(
			<GatewayModelCatalog
				provider="huggingface"
				selectedModel="zai-org/glm-5.3-flash"
				onSelectModel={onSelect}
			/>,
		);
		const kimiRow = screen.getByTitle(/setDefault.*Kimi-K3.1-Pro/);
		expect(kimiRow.getAttribute("aria-pressed")).toBe("false");
		expect(kimiRow.textContent).toContain('"price":"$0.24 / $8.4"');
		expect(kimiRow.textContent).toContain('"size":"262k"');
		expect(kimiRow.textContent).toContain('"count":3');
		const glmRow = screen.getByTitle(/setDefault.*GLM-5.3-Flash/);
		expect(glmRow.getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(kimiRow);
		expect(onSelect).toHaveBeenCalledWith("moonshotai/Kimi-K3.1-Pro");
	});

	it("filters the list and says when nothing matches", () => {
		render(<GatewayModelCatalog provider="huggingface" onSelectModel={vi.fn()} />);
		const input = screen.getByPlaceholderText(/searchPlaceholder/);
		fireEvent.change(input, { target: { value: "glm" } });
		expect(screen.queryByTitle(/Kimi/)).toBeNull();
		fireEvent.change(input, { target: { value: "nothing-like-it" } });
		expect(screen.getByText("sections.accounts.gatewayCatalog.empty")).toBeTruthy();
	});

	it("draws forty rows at most and counts the rest", () => {
		catalog.value.models = Array.from({ length: 45 }, (_, i) => ({
			value: `org/model-${i}`,
			label: `Model ${i}`,
		}));
		render(<GatewayModelCatalog provider="openrouter" onSelectModel={vi.fn()} />);
		expect(screen.getAllByRole("button")).toHaveLength(40);
		expect(screen.getByText(/gatewayCatalog.more.*"count":5/)).toBeTruthy();
	});

	it("says when the list is the offline one, and when it is loading", () => {
		catalog.value = { models: [kimi], source: "static", loading: false };
		const { unmount } = render(
			<GatewayModelCatalog provider="openrouter" onSelectModel={vi.fn()} />,
		);
		expect(screen.getByText(/gatewayCatalog.offline.*OpenRouter/)).toBeTruthy();
		unmount();
		catalog.value = { models: [], source: "live", loading: true };
		render(<GatewayModelCatalog provider="openrouter" onSelectModel={vi.fn()} />);
		expect(screen.getByText("sections.accounts.gatewayCatalog.loading")).toBeTruthy();
		expect(screen.queryByText("sections.accounts.gatewayCatalog.empty")).toBeNull();
	});
});
