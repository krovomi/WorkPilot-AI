/**
 * @vitest-environment jsdom
 */
/**
 * The incident's pull request is a link only when its URL is a web address;
 * its fix card is named, and an escalated incident can be fixed again.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Incident } from "../../../shared/types/self-healing";
import { IncidentCard } from "./IncidentCard";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { card?: string }) => (options?.card ? `${key}:${options.card}` : key),
		i18n: { language: "en" },
	}),
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

describe("IncidentCard fix card", () => {
	it("names the card whose build fixes the incident", () => {
		render(<IncidentCard incident={{ ...incident(), status: "fixing", fix_card: "012-fix-test-regression" }} />);
		expect(screen.getByText("selfHealing:fixCard:012-fix-test-regression")).toBeInTheDocument();
	});

	it("names no card when none was filed", () => {
		render(<IncidentCard incident={incident()} />);
		expect(screen.queryByText(/selfHealing:fixCard/)).toBeNull();
	});

	it.each(["pending", "escalated"] as const)("offers a fix on a %s incident", (status) => {
		const onTriggerFix = vi.fn();
		render(<IncidentCard incident={{ ...incident(), status }} onTriggerFix={onTriggerFix} />);
		fireEvent.click(screen.getByRole("button", { name: "selfHealing:fix" }));
		expect(onTriggerFix).toHaveBeenCalledWith("abc123");
	});

	it("offers no fix while the card is being built", () => {
		render(<IncidentCard incident={{ ...incident(), status: "fixing" }} onTriggerFix={vi.fn()} />);
		expect(screen.queryByRole("button", { name: "selfHealing:fix" })).toBeNull();
	});
});
