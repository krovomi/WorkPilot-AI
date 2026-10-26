/** @vitest-environment jsdom */
/**
 * Le sélecteur d'effort dit ce que le modèle reçoit.
 *
 * Les propriétés épinglées : un niveau qu'aucun réglage n'atteint est signalé
 * (et « aucun » ne l'est pas, puisqu'il ne promet rien), un niveau traduit
 * nomme la valeur envoyée, un backend muet ne produit aucune note — pas de
 * fausse alerte —, et un échec n'est pas mis en cache.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type EffortPlan,
	effortNote,
	fetchEffortPlan,
	resetEffortPlanCache,
	useEffortPlan,
} from "../useEffortPlan";

const grok43: EffortPlan = {
	control: "none",
	levels: { none: null, low: null, medium: null, high: null, ultrathink: null },
};
const opus: EffortPlan = {
	control: "native",
	levels: {
		none: "low",
		low: "low",
		medium: "medium",
		high: "high",
		ultrathink: "xhigh",
	},
};

describe("effortNote", () => {
	it("says a level has no effect where nothing reaches the model", () => {
		expect(effortNote(grok43, "high")).toEqual({ kind: "notApplied" });
		expect(effortNote(grok43, "none")).toBeNull();
	});

	it("names the value sent when it is not the level", () => {
		expect(effortNote(opus, "none")).toEqual({ kind: "sentAs", value: "low" });
		expect(effortNote(opus, "ultrathink")).toEqual({
			kind: "sentAs",
			value: "xhigh",
		});
		expect(effortNote(opus, "high")).toBeNull();
	});

	it("defers to launch time on Copilot and local servers", () => {
		expect(effortNote({ control: "runtime", levels: {} }, "high")).toEqual({
			kind: "runtime",
		});
	});

	it("says nothing without a plan", () => {
		expect(effortNote(null, "high")).toBeNull();
	});
});

describe("useEffortPlan", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		resetEffortPlanCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("asks the backend for the provider and model", async () => {
		fetchMock.mockResolvedValue({ ok: true, json: async () => grok43 });

		const { result } = renderHook(() => useEffortPlan("grok", "grok-4.3"));

		await waitFor(() => expect(result.current).toEqual(grok43));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"/providers/effort?provider=grok&model=grok-4.3",
		);
	});

	it("reads an unreadable answer as no plan, and does not keep it", async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
		expect(await fetchEffortPlan("openai", "gpt-5.5")).toBeNull();

		fetchMock.mockResolvedValueOnce({ ok: true, json: async () => opus });
		expect(await fetchEffortPlan("openai", "gpt-5.5")).toEqual(opus);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects a malformed plan", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ control: "maybe", levels: {} }),
		});
		expect(await fetchEffortPlan("x", "y")).toBeNull();
	});
});
