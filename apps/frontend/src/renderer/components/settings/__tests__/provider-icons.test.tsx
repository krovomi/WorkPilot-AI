import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderIcon } from "../provider-icons";

afterEach(cleanup);

describe("ProviderIcon", () => {
	it("draws a provider's logo, an alias with its parent's, and an initial otherwise", () => {
		const { container, rerender } = render(<ProviderIcon provider="openai" label="OpenAI" />);
		expect(container.querySelector("svg")).not.toBeNull();
		rerender(<ProviderIcon provider="gemini-cli" label="Gemini CLI" />);
		expect(container.querySelector("svg title")?.textContent).toBe("Google Gemini");
		rerender(<ProviderIcon provider="brand-new" label="brand new" className="h-8 w-8" />);
		expect(container.querySelector("svg")).toBeNull();
		expect(container.textContent).toBe("B");
		expect(container.firstElementChild?.className).toContain("h-8");
	});
});
