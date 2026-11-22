/** @vitest-environment jsdom */
/**
 * The recorder (#387), in French: a dialog the recorded page opened is
 * answered in the app; hovers, scrolls, drags, multiple lists and answered
 * dialogs are shown in the steps.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { RecordedStep } from "../../../../shared/types/browser-recorder";
import { useBrowserRecorderStore } from "../../../stores/browser-recorder-store";
import { RecorderDialog } from "../RecorderDialog";
import { RecorderTab, stepDetail } from "../RecorderTab";

vi.mock("../../../stores/project-store", () => ({
	useProjectStore: (select: (s: unknown) => unknown) => select({ selectedProjectId: "p1" }),
}));

const api = { answerBrowserRecorderDialog: vi.fn(async () => ({ success: true })) };
const initial = useBrowserRecorderStore.getState();
const card = [{ strategy: "css", value: "#card" }] as const;

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	useBrowserRecorderStore.setState(initial, true);
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
	vi.clearAllMocks();
});
afterEach(cleanup);

describe("RecorderDialog", () => {
	it("shows nothing while no dialog waits", () => {
		const { container } = render(<RecorderDialog />);
		expect(container).toBeEmptyDOMElement();
	});

	it("answers a prompt with the text typed, its message shown as text", () => {
		useBrowserRecorderStore.setState({
			pendingDialog: { id: 3, type: "prompt", message: "<b>Nom ?</b>", defaultValue: "Ada" },
		});
		render(<RecorderDialog />);
		expect(screen.getByRole("alertdialog")).toHaveTextContent("Question");
		expect(screen.getByText("<b>Nom ?</b>")).toBeInTheDocument();
		const field = screen.getByLabelText("Votre réponse");
		expect(field).toHaveValue("Ada");
		fireEvent.change(field, { target: { value: "Neo" } });
		fireEvent.click(screen.getByRole("button", { name: "OK" }));
		expect(api.answerBrowserRecorderDialog).toHaveBeenCalledWith({ id: 3, accept: true, text: "Neo" });
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});

	it("cancels a confirmation, and offers only OK for an alert", () => {
		useBrowserRecorderStore.setState({ pendingDialog: { id: 1, type: "confirm", message: "", defaultValue: "" } });
		const { rerender } = render(<RecorderDialog />);
		expect(screen.queryByLabelText("Votre réponse")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
		expect(api.answerBrowserRecorderDialog).toHaveBeenCalledWith({ id: 1, accept: false, text: "" });

		useBrowserRecorderStore.setState({ pendingDialog: { id: 2, type: "alert", message: "Fini", defaultValue: "" } });
		rerender(<RecorderDialog />);
		expect(screen.queryByRole("button", { name: "Annuler" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "OK" }));
		expect(api.answerBrowserRecorderDialog).toHaveBeenLastCalledWith({ id: 2, accept: true, text: "" });
	});
});

describe("new kinds of steps", () => {
	const steps: RecordedStep[] = [
		{ id: "s1", kind: "hover", selectors: [{ strategy: "role", role: "link", value: "Produits" }] },
		{ id: "s2", kind: "scroll", selectors: [], scrollX: 0, scrollY: 900 },
		{ id: "s3", kind: "drag", selectors: [...card], drop: [{ strategy: "css", value: "#done" }], dragMode: "html5" },
		{ id: "s4", kind: "select", selectors: [{ strategy: "css", value: "#tags" }], value: "a", values: ["a", "b"] },
		{ id: "s5", kind: "click", selectors: [...card], dialog: { type: "confirm", accept: false } },
		{ id: "s6", kind: "click", selectors: [...card], dialog: { type: "prompt", accept: true, text: "Neo" } },
	];

	it("says what each step does", () => {
		useBrowserRecorderStore.setState({ steps });
		render(<RecorderTab projectPath="/p" />);
		const list = screen.getByTestId("recorder-steps");
		for (const kind of ["Survoler", "Faire défiler", "Glisser"]) expect(list).toHaveTextContent(kind);
		expect(list).toHaveTextContent("la page");
		expect(list).toHaveTextContent("0, 900");
		expect(list).toHaveTextContent('sur css "#done"');
		expect(list).toHaveTextContent("a, b");
		expect(list).toHaveTextContent("Confirmation : annulée");
		expect(list).toHaveTextContent("Question : réponse OK");
	});

	it("details a scroll, a multiple list, a value or nothing", () => {
		expect(stepDetail(steps[1])).toBe("0, 900");
		expect(stepDetail({ id: "s9", kind: "scroll", selectors: [...card] })).toBe("0, 0");
		expect(stepDetail(steps[3])).toBe("a, b");
		expect(stepDetail({ id: "s9", kind: "assert_text", selectors: [...card], text: "Hi" })).toBe("Hi");
		expect(stepDetail({ id: "s9", kind: "click", selectors: [...card] })).toBe("");
		expect(stepDetail({ id: "s9", kind: "navigate", selectors: [], url: "http://a/" })).toBe("");
	});
});
