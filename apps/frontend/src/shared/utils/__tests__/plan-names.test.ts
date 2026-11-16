import { describe, expect, it } from "vitest";
import {
	chatgptPlanName,
	claudePlanName,
	copilotPlanName,
	cursorPlanName,
	readableIdentifier,
	windsurfPlanName,
} from "../plan-names";

describe("readableIdentifier", () => {
	it("turns a provider identifier into words", () => {
		expect(readableIdentifier("some_new-tier")).toBe("Some New Tier");
		expect(readableIdentifier("  ULTRA  ")).toBe("Ultra");
	});
});

describe("claudePlanName", () => {
	it("names Max with its multiplier from the rate limit tier", () => {
		expect(claudePlanName("max", "default_claude_max_20x")).toBe(
			"Claude Max 20x",
		);
		expect(claudePlanName("MAX", "default_claude_max_5x")).toBe("Claude Max 5x");
	});

	it("names Max alone when the tier says no multiplier", () => {
		expect(claudePlanName("max")).toBe("Claude Max");
		expect(claudePlanName("max", "default_claude_ai")).toBe("Claude Max");
		expect(claudePlanName("max", null)).toBe("Claude Max");
	});

	it("names the other plans Claude Code reports", () => {
		expect(claudePlanName("pro")).toBe("Claude Pro");
		expect(claudePlanName("team")).toBe("Claude Team");
		expect(claudePlanName("enterprise")).toBe("Claude Enterprise");
		expect(claudePlanName("free")).toBe("Claude Free");
	});

	it("shows an unknown plan as reported, never a guess", () => {
		expect(claudePlanName("team_premium")).toBe("Claude Team Premium");
	});

	it("says nothing without a plan", () => {
		expect(claudePlanName(undefined)).toBeUndefined();
		expect(claudePlanName(null)).toBeUndefined();
		expect(claudePlanName("   ")).toBeUndefined();
		expect(claudePlanName("x".repeat(65))).toBeUndefined();
	});
});

describe("chatgptPlanName", () => {
	it("names the ChatGPT plans", () => {
		expect(chatgptPlanName("free")).toBe("ChatGPT Free");
		expect(chatgptPlanName("go")).toBe("ChatGPT Go");
		expect(chatgptPlanName("plus")).toBe("ChatGPT Plus");
		expect(chatgptPlanName("Pro")).toBe("ChatGPT Pro");
		expect(chatgptPlanName("team")).toBe("ChatGPT Team");
		expect(chatgptPlanName("business")).toBe("ChatGPT Business");
		expect(chatgptPlanName("enterprise")).toBe("ChatGPT Enterprise");
		expect(chatgptPlanName("edu")).toBe("ChatGPT Edu");
	});

	it("shows an unknown plan as reported", () => {
		expect(chatgptPlanName("pro_lite")).toBe("ChatGPT Pro Lite");
	});

	it("says nothing without a plan", () => {
		expect(chatgptPlanName(undefined)).toBeUndefined();
		expect(chatgptPlanName("")).toBeUndefined();
	});
});

describe("copilotPlanName", () => {
	it("tells Pro+ from Pro inside the individual plan by the sku", () => {
		expect(copilotPlanName("individual")).toBe("Copilot Pro");
		expect(copilotPlanName("individual", "monthly_subscriber_quota")).toBe(
			"Copilot Pro",
		);
		expect(copilotPlanName("individual", "plus_monthly_subscriber_quota")).toBe(
			"Copilot Pro+",
		);
		expect(copilotPlanName("individual_pro")).toBe("Copilot Pro+");
	});

	it("names Free from the plan or the sku", () => {
		expect(copilotPlanName("free")).toBe("Copilot Free");
		expect(copilotPlanName("individual", "free_limited_copilot")).toBe(
			"Copilot Free",
		);
		expect(copilotPlanName(undefined, "free_limited_copilot")).toBe(
			"Copilot Free",
		);
	});

	it("names Business and Enterprise", () => {
		expect(copilotPlanName("business")).toBe("Copilot Business");
		expect(copilotPlanName("enterprise")).toBe("Copilot Enterprise");
	});

	it("shows an unknown plan as reported, and nothing without one", () => {
		expect(copilotPlanName("education")).toBe("Copilot Education");
		expect(copilotPlanName(undefined)).toBeUndefined();
		expect(copilotPlanName(null, null)).toBeUndefined();
	});
});

describe("windsurfPlanName", () => {
	it("prefixes the plan the IDE caches", () => {
		expect(windsurfPlanName("Pro")).toBe("Windsurf Pro");
		expect(windsurfPlanName("Windsurf Teams")).toBe("Windsurf Teams");
	});

	it("says nothing without a plan", () => {
		expect(windsurfPlanName(undefined)).toBeUndefined();
		expect(windsurfPlanName("")).toBeUndefined();
	});
});

describe("cursorPlanName", () => {
	it("names the Cursor memberships", () => {
		expect(cursorPlanName("free")).toBe("Cursor Hobby");
		expect(cursorPlanName("free_trial")).toBe("Cursor Pro Trial");
		expect(cursorPlanName("pro")).toBe("Cursor Pro");
		expect(cursorPlanName("pro_plus")).toBe("Cursor Pro+");
		expect(cursorPlanName("ultra")).toBe("Cursor Ultra");
		expect(cursorPlanName("business")).toBe("Cursor Teams");
		expect(cursorPlanName("team")).toBe("Cursor Teams");
		expect(cursorPlanName("enterprise")).toBe("Cursor Enterprise");
	});

	it("shows an unknown membership as reported, and nothing without one", () => {
		expect(cursorPlanName("pro_max")).toBe("Cursor Pro Max");
		expect(cursorPlanName(undefined)).toBeUndefined();
	});
});
