import { describe, expect, it } from "vitest";
import {
	SECRET_RENEWAL_DAYS,
	secretAgeDays,
	secretNeedsRenewal,
	stampSecretDates,
} from "../secret-age";

const isSecret = (key: string) => key.endsWith("ApiKey");
const NOW = new Date("2026-10-30T12:00:00.000Z");
const EARLIER = "2026-06-01T08:00:00.000Z";

describe("stampSecretDates", () => {
	it("dates a new key now", () => {
		expect(
			stampSecretDates({ openAIApiKey: "sk-new" }, {}, {}, isSecret, NOW),
		).toEqual({ openAIApiKey: NOW.toISOString() });
	});

	it("keeps the date of a key saved again with the same value", () => {
		expect(
			stampSecretDates(
				{ openAIApiKey: "sk-same", theme: "dark" },
				{ openAIApiKey: "sk-same", theme: "light" },
				{ openAIApiKey: EARLIER },
				isSecret,
				NOW,
			),
		).toEqual({ openAIApiKey: EARLIER });
	});

	it("dates a changed key now", () => {
		expect(
			stampSecretDates(
				{ openAIApiKey: "sk-rotated" },
				{ openAIApiKey: "sk-old" },
				{ openAIApiKey: EARLIER },
				isSecret,
				NOW,
			),
		).toEqual({ openAIApiKey: NOW.toISOString() });
	});

	it("never dates an unchanged key that had no date: its age stays unknown", () => {
		expect(
			stampSecretDates(
				{ openAIApiKey: "sk-legacy" },
				{ openAIApiKey: "sk-legacy" },
				undefined,
				isSecret,
				NOW,
			),
		).toEqual({});
	});

	it("drops the date of an emptied or removed key, and of anything not a secret", () => {
		expect(
			stampSecretDates(
				{ openAIApiKey: "", theme: "dark" },
				{ openAIApiKey: "sk-old", groqApiKey: "gsk-old", theme: "dark" },
				{ openAIApiKey: EARLIER, groqApiKey: EARLIER, theme: EARLIER },
				isSecret,
				NOW,
			),
		).toEqual({});
	});

	it("ignores a stored date it cannot read", () => {
		expect(
			stampSecretDates(
				{ openAIApiKey: "sk-same" },
				{ openAIApiKey: "sk-same" },
				{ openAIApiKey: "not a date" },
				isSecret,
				NOW,
			),
		).toEqual({});
	});
});

describe("secretAgeDays", () => {
	const now = NOW.getTime();

	it("counts whole days from an ISO date or a millisecond timestamp", () => {
		expect(secretAgeDays("2026-10-29T13:00:00.000Z", now)).toBe(0);
		expect(secretAgeDays("2026-10-20T12:00:00.000Z", now)).toBe(10);
		expect(secretAgeDays(Date.parse("2026-08-01T12:00:00.000Z"), now)).toBe(
			90,
		);
	});

	it("is unknown without a usable date", () => {
		expect(secretAgeDays(undefined, now)).toBeUndefined();
		expect(secretAgeDays("garbage", now)).toBeUndefined();
		expect(secretAgeDays(0, now)).toBeUndefined();
	});

	it("never goes below zero for a clock that moved back", () => {
		expect(secretAgeDays("2026-11-02T00:00:00.000Z", now)).toBe(0);
	});
});

describe("secretNeedsRenewal", () => {
	it("asks for renewal from the threshold on, and never for an unknown age", () => {
		expect(secretNeedsRenewal(SECRET_RENEWAL_DAYS - 1)).toBe(false);
		expect(secretNeedsRenewal(SECRET_RENEWAL_DAYS)).toBe(true);
		expect(secretNeedsRenewal(undefined)).toBe(false);
	});
});
