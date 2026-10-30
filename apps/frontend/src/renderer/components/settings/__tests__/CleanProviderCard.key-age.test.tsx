/**
 * Réglages > Comptes says how old a stored API key is, and suggests renewing
 * it past SECRET_RENEWAL_DAYS (plan of 29 October, S5). An undated key is
 * shown as such, never as old or new.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECRET_RENEWAL_DAYS } from "../../../../shared/utils/secret-age";
import { CleanProviderCard } from "../CleanProviderCard";

vi.mock("react-i18next", () => {
	const t = (key: string, options?: { count?: number }) =>
		options?.count === undefined ? key : `${key}:${options.count}`;
	return { useTranslation: () => ({ t, i18n: { language: "en" } }) };
});

const NOW = new Date("2026-10-30T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const KEY = "sections.accounts.providerCard";

type Info = Parameters<typeof CleanProviderCard>[0]["provider"]["realApiKeyInfo"];

function renderCard(realApiKeyInfo: Info) {
	render(
		<CleanProviderCard
			provider={{
				id: "openai",
				name: "OpenAI",
				category: "openai",
				isConfigured: true,
				isWorking: true,
				realApiKeyInfo,
			}}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: `${KEY}.toggleDetails` }));
}

function apiKey(setAt?: string | number): Info {
	return {
		hasKey: true,
		keyPreview: "sk-proj-0000",
		authMethod: "api-key",
		setAt,
	};
}

describe("CleanProviderCard key age", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows how many days ago the key was saved, without a reminder", () => {
		renderCard(apiKey(new Date(NOW.getTime() - 12 * DAY).toISOString()));

		expect(screen.getByText(`${KEY}.keySaved`)).toBeInTheDocument();
		expect(screen.getByText(`${KEY}.keySavedDaysAgo:12`)).toBeInTheDocument();
		expect(screen.queryByText(/keyRenewal/)).not.toBeInTheDocument();
	});

	it("says today for a key saved today", () => {
		renderCard(apiKey(NOW.getTime() - 60_000));

		expect(screen.getByText(`${KEY}.keySavedToday`)).toBeInTheDocument();
	});

	it(`suggests renewing a key saved ${SECRET_RENEWAL_DAYS} days ago or more`, () => {
		renderCard(apiKey(NOW.getTime() - (SECRET_RENEWAL_DAYS + 5) * DAY));

		expect(
			screen.getByText(`${KEY}.keyRenewal:${SECRET_RENEWAL_DAYS + 5}`),
		).toBeInTheDocument();
	});

	it("says the date is unknown for an undated key, and never asks to renew it", () => {
		renderCard(apiKey(undefined));

		expect(screen.getByText(`${KEY}.keySavedUnknown`)).toBeInTheDocument();
		expect(screen.queryByText(/keyRenewal/)).not.toBeInTheDocument();
	});

	it("shows no key age for an OAuth connection", () => {
		renderCard({
			hasKey: true,
			isOAuth: true,
			authMethod: "oauth",
			setAt: NOW.getTime() - 400 * DAY,
		});

		expect(screen.queryByText(`${KEY}.keySaved`)).not.toBeInTheDocument();
		expect(screen.queryByText(/keyRenewal/)).not.toBeInTheDocument();
	});
});
