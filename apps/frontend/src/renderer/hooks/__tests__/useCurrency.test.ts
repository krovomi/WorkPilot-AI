/**
 * Costs in the app's language: dollars in English, euros in French at one
 * shared rate, read from one exchange service, once for pages that ask
 * together, kept for a day, and kept as it was when the service is down.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Currency = typeof import("../../lib/currency");
type Hook = typeof import("../useCurrency");
let currency: Currency;
let hook: Hook;
const fetchMock = vi.fn();
const rateAnswer = (eur: unknown) => ({ ok: true, json: async () => ({ rates: { EUR: eur } }) });

beforeEach(async () => {
	vi.resetModules();
	currency = await import("../../lib/currency");
	hook = await import("../useCurrency");
	fetchMock.mockReset().mockResolvedValue(rateAnswer(0.9));
	vi.stubGlobal("fetch", fetchMock);
	await i18n.changeLanguage("en");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the EUR rate", () => {
	it("starts from a sensible default, then reads the service once for everyone asking", async () => {
		expect(currency.knownEurRate()).toBe(0.92);
		const [a, b] = await Promise.all([currency.getEurRate(), currency.getEurRate()]);
		expect([a, b]).toEqual([0.9, 0.9]);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith("https://open.er-api.com/v6/latest/USD");
		expect(currency.knownEurRate()).toBe(0.9);
	});

	it("keeps the rate for a day, then reads it again", async () => {
		vi.useFakeTimers({ now: new Date("2026-11-16T08:00:00Z") });
		await currency.getEurRate();
		vi.setSystemTime(new Date("2026-11-17T07:59:00Z"));
		await currency.getEurRate();
		expect(fetchMock).toHaveBeenCalledOnce();
		fetchMock.mockResolvedValueOnce(rateAnswer(0.95));
		vi.setSystemTime(new Date("2026-11-17T08:01:00Z"));
		expect(await currency.getEurRate()).toBe(0.95);
	});

	it.each([
		["the service is down", () => fetchMock.mockRejectedValueOnce(new Error("offline"))],
		["the service refuses", () => fetchMock.mockResolvedValueOnce({ ok: false })],
		["the answer has no rate", () => fetchMock.mockResolvedValueOnce(rateAnswer(undefined))],
		["the rate is not positive", () => fetchMock.mockResolvedValueOnce(rateAnswer(0))],
	])("keeps the rate it had when %s, and asks again next time", async (_name, fail) => {
		fail();
		expect(await currency.getEurRate()).toBe(0.92);
		expect(await currency.getEurRate()).toBe(0.9);
	});
});

describe("formatting a cost", () => {
	it("shows dollars, or euros in French", () => {
		expect(currency.formatCurrency(1.5, "en", 0.9)).toBe("$1.5000");
		expect(currency.formatCurrency(2, "fr-FR", 0.9, 2)).toBe("1.80 €");
	});
});

describe("useCurrency", () => {
	it("asks nothing in English", () => {
		const { result } = renderHook(() => hook.useCurrency());
		expect(result.current.rate).toBe(0.92);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads the shared rate in French", async () => {
		await i18n.changeLanguage("fr");
		const { result } = renderHook(() => hook.useCurrency());
		await vi.waitFor(() => expect(result.current.rate).toBe(0.9));
	});

	it("drops a rate that arrives after the page closed", async () => {
		await i18n.changeLanguage("fr");
		let answer: (value: unknown) => void = vi.fn();
		fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const { result, unmount } = renderHook(() => hook.useCurrency());
		unmount();
		await act(async () => answer(rateAnswer(0.5)));
		expect(result.current.rate).toBe(0.92);
	});
});
