/**
 * @vitest-environment jsdom
 */
/**
 * The incident's pull request is a link only when its URL is a web address.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Incident } from "../../../shared/types/self-healing";
import { IncidentCard } from "./IncidentCard";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

function incident(fix_pr_url?: string): Incident {
	return {
		id: "abc123",
		mode: "cicd",
		source: "git_push",
		severity: "medium",
		title: "Test regression",
		description: "Tests broke",
		status: "resolved",
		created_at: "2026-10-10T00:00:00",
		source_data: {},
		affected_files: [],
		...(fix_pr_url === undefined ? {} : { fix_pr_url }),
	};
}

describe("IncidentCard pull request link", () => {
	it("links to the fix's pull request", () => {
		render(<IncidentCard incident={incident("https://github.com/acme/shop/pull/3")} />);
		expect(screen.getByRole("link", { name: "selfHealing:viewPR" })).toHaveAttribute(
			"href",
			"https://github.com/acme/shop/pull/3",
		);
	});

	it.each(["javascript:alert(1)", "file:///etc/hosts", "not a url"])("shows no link for %s", (url) => {
		render(<IncidentCard incident={incident(url)} />);
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("shows no link without a pull request", () => {
		render(<IncidentCard incident={incident()} />);
		expect(screen.queryByRole("link")).toBeNull();
	});
});
