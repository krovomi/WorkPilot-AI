/**
 * The keyboard shortcuts overlay (Ctrl+/): every label translated, the menu's
 * own two-letter shortcuts read from the menu as it stands, and three ways to
 * close it (Escape, the cross, a click outside the panel).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { LayoutGrid, TerminalSquare } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { KeyboardShortcutsOverlay } from "../KeyboardShortcutsOverlay";
import { useNavIndexStore } from "../sidebar/nav-index";

const MENU = [
	{
		view: "kanban",
		labelKey: "navigation:items.kanban",
		icon: LayoutGrid,
		shortcut: "WK",
		placeKeys: [],
		experimental: false,
	},
	{
		view: "terminals",
		labelKey: "navigation:items.terminals",
		icon: TerminalSquare,
		shortcut: "TM",
		placeKeys: [],
		experimental: false,
	},
	// A page without a shortcut is not listed
	{
		view: "insights",
		labelKey: "navigation:items.insights",
		icon: LayoutGrid,
		placeKeys: [],
		experimental: false,
	},
] as const;

function renderOverlay(open = true) {
	const onOpenChange = vi.fn();
	const view = render(<KeyboardShortcutsOverlay open={open} onOpenChange={onOpenChange} />);
	return { onOpenChange, ...view };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useNavIndexStore.setState({ entries: [] });
});

describe("KeyboardShortcutsOverlay", () => {
	it("renders nothing while closed, and does not listen for Escape", () => {
		const { onOpenChange, container } = renderOverlay(false);
		expect(container).toBeEmptyDOMElement();
		fireEvent.keyDown(globalThis.window, { key: "Escape" });
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("lists the shortcuts the app listens for, in the app's language", async () => {
		renderOverlay();
		const dialog = screen.getByRole("dialog", { name: "Keyboard Shortcuts" });
		expect(within(dialog).getByText("Go to Kanban")).toBeInTheDocument();
		expect(within(dialog).getByText("Command palette")).toBeInTheDocument();
		// A new terminal is Ctrl+T in the Terminals view, not Ctrl+Shift+T
		const newTerminal = within(dialog).getByText("New terminal (in Terminals)").parentElement;
		expect(newTerminal).toHaveTextContent("Ctrl+T");
		expect(newTerminal).not.toHaveTextContent("Shift");
		// No menu shortcut is shown before the menu published its pages
		expect(within(dialog).queryByText("Menu")).not.toBeInTheDocument();

		await i18n.changeLanguage("fr");
		expect(await within(dialog).findByText("Aller au Kanban")).toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: "Raccourcis clavier" })).toBe(dialog);
	});

	it("shows the menu's two-letter shortcuts as the menu has them", () => {
		useNavIndexStore.setState({ entries: [...MENU] });
		renderOverlay();
		const heading = screen.getByRole("heading", { name: "Menu" });
		const section = heading.parentElement as HTMLElement;
		expect(within(section).getByText("Kanban board").parentElement).toHaveTextContent("WK");
		expect(within(section).getByText("Agent terminals").parentElement).toHaveTextContent(
			"TM",
		);
		expect(within(section).queryByText("Insights")).not.toBeInTheDocument();
		// The stale single-letter list is gone
		expect(screen.queryByText("Kanban (sidebar)")).not.toBeInTheDocument();
	});

	it("closes on Escape, ignoring other keys", () => {
		const { onOpenChange, unmount } = renderOverlay();
		fireEvent.keyDown(globalThis.window, { key: "a" });
		expect(onOpenChange).not.toHaveBeenCalled();
		fireEvent.keyDown(globalThis.window, { key: "Escape" });
		expect(onOpenChange).toHaveBeenCalledWith(false);

		// Unmounted, it stops listening
		unmount();
		fireEvent.keyDown(globalThis.window, { key: "Escape" });
		expect(onOpenChange).toHaveBeenCalledOnce();
	});

	it("closes from its cross and from a click outside the panel, not inside it", () => {
		const { onOpenChange } = renderOverlay();
		fireEvent.click(screen.getByRole("dialog"));
		expect(onOpenChange).not.toHaveBeenCalled();

		const [backdrop, cross] = screen.getAllByRole("button", { name: "Close" });
		fireEvent.click(cross);
		expect(onOpenChange).toHaveBeenCalledTimes(1);
		fireEvent.click(backdrop);
		expect(onOpenChange).toHaveBeenCalledTimes(2);
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
	});
});
