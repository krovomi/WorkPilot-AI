/**
 * The libraries the generated tests are written against: grouped by
 * category, marked installed or to add, with the packages to add and what an
 * install did.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PackageInstallReport,
	TestLibrary,
	TestLibrarySelection,
} from "../../../../shared/types/test-generation";
import { TestLibrariesPicker } from "../TestLibrariesPicker";

function library(id: string, overrides: Partial<TestLibrary> = {}): TestLibrary {
	return {
		id,
		name: id,
		package: `Pkg.${id}`,
		ecosystem: "nuget",
		language: "csharp",
		category: "framework",
		usage: `Write with ${id}`,
		recommended: false,
		installed: false,
		...overrides,
	};
}

const XUNIT = library("xunit", { installed: true });
const FLUENT = library("fluent", { category: "assertions" });
const MOQ = library("moq", { category: "mocking" });
const NUNIT = library("nunit");

function selection(overrides: Partial<TestLibrarySelection> = {}): TestLibrarySelection {
	return {
		language: "csharp",
		selected: ["xunit"],
		installed: ["xunit"],
		explicit: false,
		libraries: [XUNIT, FLUENT, NUNIT, MOQ],
		missing: [],
		installCommands: [],
		...overrides,
	};
}

const onToggle = vi.fn();
const onReset = vi.fn();
const onAddPackages = vi.fn();

function renderPicker(props: Partial<ComponentProps<typeof TestLibrariesPicker>> = {}) {
	return render(
		<TestLibrariesPicker
			selection={selection()}
			chosen={["xunit"]}
			missing={[]}
			loading={false}
			installing={false}
			report={null}
			error={null}
			onToggle={onToggle}
			onReset={onReset}
			onAddPackages={onAddPackages}
			{...props}
		/>,
	);
}

function report(overrides: Partial<PackageInstallReport> = {}): PackageInstallReport {
	return {
		ok: true,
		installed: ["fluent", "moq"],
		steps: [],
		manualCommands: [],
		reason: "",
		target: "App.Tests.csproj",
		...overrides,
	};
}

describe("TestLibrariesPicker", () => {
	beforeEach(() => vi.resetAllMocks());

	it("says it is reading the project", () => {
		renderPicker({ loading: true });
		expect(screen.getByText("Reading the project's packages…")).toBeInTheDocument();
	});

	it.each([
		["no selection", null],
		["nothing on offer", selection({ libraries: [] })],
	])("shows nothing with %s", (_label, value) => {
		const { container } = renderPicker({ selection: value });
		expect(container).toBeEmptyDOMElement();
	});

	it("groups the libraries by category in the order received", () => {
		renderPicker();
		const headings = ["Framework", "Assertions", "Mocking"].map((name) => screen.getByText(name));
		expect(headings[0].compareDocumentPosition(headings[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(headings[1].compareDocumentPosition(headings[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// Both frameworks under one heading, though the backend listed them apart.
		expect(screen.getAllByText("Framework")).toHaveLength(1);
		expect(screen.getByText("Pkg.nunit")).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: /xunit/ }).closest("[title]")).toHaveAttribute(
			"title",
			"Write with xunit",
		);
	});

	it("marks what is installed and what a choice adds", () => {
		renderPicker({ chosen: ["xunit", "fluent"] });

		expect(screen.getByRole("checkbox", { name: /xunit/ })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: /xunit/ })).toHaveAccessibleName(/installed/);
		expect(screen.getByRole("checkbox", { name: /fluent/ })).toHaveAccessibleName(/to add/);
		expect(screen.getByRole("checkbox", { name: /moq/ })).not.toBeChecked();
		expect(screen.getByRole("checkbox", { name: /moq/ })).not.toHaveAccessibleName(/to add/);
	});

	it("toggles a library and goes back to the project default", async () => {
		renderPicker();
		await userEvent.click(screen.getByRole("checkbox", { name: /moq/ }));
		expect(onToggle).toHaveBeenCalledWith("moq");

		await userEvent.click(screen.getByRole("button", { name: "Project default" }));
		expect(onReset).toHaveBeenCalled();
	});

	it("names the packages to add, how, and adds them", async () => {
		renderPicker({
			chosen: ["xunit", "fluent", "moq"],
			missing: [FLUENT, MOQ],
			selection: selection({ installCommands: ["dotnet add package Pkg.fluent", "dotnet add package Pkg.moq"] }),
		});

		expect(screen.getByText(/2 packages are not referenced yet \(Pkg\.fluent, Pkg\.moq\)/)).toBeInTheDocument();
		expect(screen.getByText(/dotnet add package Pkg\.fluent\s+dotnet add package Pkg\.moq/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Add 2 packages" }));
		expect(onAddPackages).toHaveBeenCalled();
	});

	it("offers no install without a project and no command when there is none", () => {
		const { container } = renderPicker({ missing: [FLUENT], canInstall: false, compact: true });
		expect(screen.getByText(/1 package is not referenced yet \(Pkg\.fluent\)/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Add 1 package/ })).not.toBeInTheDocument();
		expect(container.querySelector("pre")).toBeNull();
	});

	it("locks the choice while installing", () => {
		renderPicker({ missing: [FLUENT], installing: true });
		expect(screen.getByRole("button", { name: "Add 1 package" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Project default" })).toBeDisabled();
		for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
	});

	it("says where the packages went", () => {
		renderPicker({ report: report() });
		expect(screen.getByText("2 packages added to App.Tests.csproj.")).toBeInTheDocument();
	});

	it("shows the output of the steps that failed and what to run by hand", () => {
		renderPicker({
			report: report({
				ok: false,
				installed: [],
				steps: [
					{ command: ["dotnet", "add", "package", "Pkg.fluent"], ok: false, output: "NU1101: not found" },
					{ command: ["dotnet", "add", "package", "Pkg.moq"], ok: true, output: "added" },
				],
				manualCommands: ["mvn install"],
			}),
			error: "Install refused",
		});

		expect(screen.getByText("Some packages could not be added.")).toBeInTheDocument();
		expect(screen.getByText("NU1101: not found")).toBeInTheDocument();
		expect(screen.queryByText("added")).not.toBeInTheDocument();
		expect(screen.getByText("Run these yourself:")).toBeInTheDocument();
		expect(screen.getByText("mvn install")).toBeInTheDocument();
		expect(screen.getByText("Install refused")).toBeInTheDocument();
	});
});
