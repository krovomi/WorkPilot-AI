/** @vitest-environment jsdom */
/**
 * A memory conflict a local embeddings model found (#352) says so: the two
 * notes disagree without words in common, which a person should know before
 * trusting the pairing.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { MemoryConflict } from "../../../../../shared/types";
import { ConflictResolver } from "../ConflictResolver";

const BASE = "knowledge/projects/shop/memory";

function side(name: string, text: string) {
	return {
		path: `${BASE}/gotchas/${name}.md`,
		title: name,
		text,
		preview: "",
		updated: "",
		pinned: false,
		confidence: null,
		agents: [],
		tasks: [],
	};
}

const PAIR: MemoryConflict = {
	id: "0123456789abcdef",
	kind: "gotcha",
	signal: "negation",
	detail: "≈ 0.91",
	textual: false,
	detected_at: "2026-11-20T10:00:00+00:00",
	a: side("always", "Always run the migrations before the tests."),
	b: side("never", "Never apply schema changes ahead of the test suite."),
};

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(cleanup);

it("marks a pair found by meaning", () => {
	render(<ConflictResolver projectId="p1" conflict={{ ...PAIR, found_by: "embeddings" }} onResolved={vi.fn()} />);
	expect(screen.getByTestId("memory-conflict-found-by")).toHaveTextContent("Found by meaning (local model)");
	expect(screen.getByText("≈ 0.91")).toBeInTheDocument();
});

it("in French too", async () => {
	await i18n.changeLanguage("fr");
	render(<ConflictResolver projectId="p1" conflict={{ ...PAIR, found_by: "embeddings" }} onResolved={vi.fn()} />);
	expect(screen.getByTestId("memory-conflict-found-by")).toHaveTextContent("Trouvé par le sens (modèle local)");
});

it("says nothing more for a pair found by its words", () => {
	render(<ConflictResolver projectId="p1" conflict={{ ...PAIR, found_by: "lexical" }} onResolved={vi.fn()} />);
	expect(screen.queryByTestId("memory-conflict-found-by")).not.toBeInTheDocument();
});
