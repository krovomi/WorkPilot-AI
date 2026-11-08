/**
 * @vitest-environment jsdom
 */

/**
 * MobileTargetsFields — the task form's "Mobile platforms" box.
 *
 * Pinned: on a project with an app the detected framework is named and a
 * platform the app lacks is greyed out; on a project without one a preamble
 * says that checking a platform adds setup tasks, and once one is checked the
 * framework choice and the tasks to be added are listed.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { MobileProfile } from "../../../../shared/types/mobile";
import type { MobileSetupPlan } from "../../../lib/mobile-setup";
import { MobileTargetsFields } from "../MobileTargetsFields";
import type { MobileSetupState } from "../useMobileSetup";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

const flutter = {
	id: "flutter",
	label: "Flutter",
	platforms: ["android", "ios"] as ("android" | "ios")[],
	install: [],
	scaffold: [],
	platformSetup: {},
	docs: "",
	notes: "",
};
const maui = { ...flutter, id: "dotnet-maui", label: ".NET MAUI" };

const NO_APP: MobileProfile = {
	success: true,
	isMobile: false,
	hostStacks: ["dotnet"],
	mobileDir: "mobile",
	frameworks: [maui, flutter],
};

function state(profile: MobileProfile, plan: MobileSetupPlan | null = null): MobileSetupState {
	return { profile, plan, choices: [maui, flutter], locked: false, setFramework: vi.fn() };
}

describe("MobileTargetsFields", () => {
	it("names the app found and greys out a platform it does not have", () => {
		render(
			<MobileTargetsFields
				targets={[]}
				onTargetsChange={vi.fn()}
				setup={state({
					success: true,
					isMobile: true,
					stack: { framework: "android-native", platforms: ["android"] },
				})}
				idPrefix="t-"
			/>,
		);
		expect(screen.getByText(/mobile:targets\.detected/)).toBeInTheDocument();
		expect(screen.queryByTestId("mobile-setup-preamble")).toBeNull();
		expect(document.getElementById("t-mobile-ios")).toBeDisabled();
		expect(document.getElementById("t-mobile-android")).not.toBeDisabled();
	});

	it("warns up front, on a project without an app, that setup tasks will be added", () => {
		const onChange = vi.fn();
		render(
			<MobileTargetsFields
				targets={[]}
				onTargetsChange={onChange}
				setup={state(NO_APP)}
				idPrefix="t-"
			/>,
		);
		expect(screen.getByTestId("mobile-setup-preamble")).toHaveTextContent(
			"mobile:targets.noAppPreamble",
		);
		expect(screen.getByText(/mobile:targets\.hostStacks/)).toBeInTheDocument();
		expect(screen.queryByTestId("mobile-setup-plan")).toBeNull();

		fireEvent.click(document.getElementById("t-mobile-ios") as HTMLElement);
		expect(onChange).toHaveBeenCalledWith(["ios"]);
	});

	it("lists the framework choice and the tasks to add once a platform is checked", () => {
		const setup = state(NO_APP, {
			framework: maui,
			install: { mark: { framework: "dotnet-maui", step: "install" }, title: "Install MAUI" },
			platforms: [
				{
					mark: { framework: "dotnet-maui", step: "platform", platform: "android" },
					title: "Prepare Android",
					existing: { id: "x" } as never,
				},
			],
		});
		render(
			<MobileTargetsFields
				targets={["android"]}
				onTargetsChange={vi.fn()}
				setup={setup}
				idPrefix="t-"
			/>,
		);
		const plan = screen.getByTestId("mobile-setup-plan");
		expect(plan).toHaveTextContent("Install MAUI");
		expect(plan).toHaveTextContent("mobile:targets.reused");
		expect(plan).toHaveTextContent("mobile:targets.thisTaskWaits");

		const select = document.getElementById("t-mobile-framework") as HTMLSelectElement;
		expect(select.value).toBe("dotnet-maui");
		expect(select.options[0].textContent).toContain("mobile:targets.recommended");
		fireEvent.change(select, { target: { value: "flutter" } });
		expect(setup.setFramework).toHaveBeenCalledWith("flutter");
	});

	it("shows the plain description while the profile is unknown", () => {
		render(<MobileTargetsFields targets={[]} onTargetsChange={vi.fn()} idPrefix="" />);
		expect(screen.getByText("mobile:targets.description")).toBeInTheDocument();
		expect(document.getElementById("mobile-ios")).not.toBeDisabled();
	});
});
