/**
 * @vitest-environment jsdom
 */

/**
 * RichTextEditor — the WYSIWYG description of an imported task: it shows the
 * HTML rendered (sanitized, with the tracker's black-on-white neutralised),
 * emits what is typed, formats through the toolbar and inserts links.
 *
 * jsdom has no editing commands: `document.execCommand` and
 * `document.queryCommandState` are given to it here, as the browser would.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { RichTextEditor } from "../RichTextEditor";

const execCommand = vi.fn((_command: string, _ui?: boolean, _value?: string) => true);
const queryCommandState = vi.fn((_command: string) => false);

beforeEach(async () => {
	await i18n.changeLanguage("en");
	execCommand.mockClear();
	queryCommandState.mockReset().mockReturnValue(false);
	Object.assign(document, { execCommand, queryCommandState });
	window.getSelection()?.removeAllRanges();
});
afterEach(cleanup);

const editor = () => screen.getByRole("textbox");
const tool = (name: string) => screen.getByRole("button", { name });

/** Put the caret (or a selection) inside `node`. */
function select(node: Node, start = 0, end = start) {
	const range = document.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	const selection = window.getSelection() as Selection;
	selection.removeAllRanges();
	selection.addRange(range);
	return range;
}

function renderEditor(props: Partial<Parameters<typeof RichTextEditor>[0]> = {}) {
	const onChange = vi.fn();
	const view = render(
		<RichTextEditor value="" onChange={onChange} placeholder="Describe the task" {...props} />,
	);
	return { onChange, ...view };
}

describe("RichTextEditor", () => {
	it("renders imported HTML safely and adapts its colors to the theme", () => {
		renderEditor({
			value:
				'<p style="color: #000000; background-color: #ffffff">Hello <b>team</b></p>' +
				'<script>alert(1)</script><img src="x.png" onerror="alert(2)">' +
				'<span style="color: rgb(0, 0, 0); background-color: rgb(255, 255, 255)">a</span>' +
				'<span style="color: black; background-color: white">b</span>',
		});
		const html = editor().innerHTML;
		expect(editor()).toHaveTextContent("Hello team");
		expect(html).not.toContain("script");
		expect(html).not.toContain("onerror");
		expect(html).not.toMatch(/#000|#fff|rgb\(|black|white/);
		expect(html).toContain("color: inherit");
		expect(html).toContain("background-color: transparent");
		expect(screen.queryByText("Describe the task")).not.toBeInTheDocument();
	});

	it("shows the placeholder only while it is empty; an image alone is content", () => {
		const { rerender, onChange } = renderEditor();
		expect(screen.getByText("Describe the task")).toBeInTheDocument();
		rerender(
			<RichTextEditor value='<img src="a.png" alt="">' onChange={onChange} placeholder="Describe the task" />,
		);
		expect(screen.queryByText("Describe the task")).not.toBeInTheDocument();
		rerender(<RichTextEditor value="" onChange={onChange} />);
		expect(screen.queryByText("Describe the task")).not.toBeInTheDocument();
	});

	it("emits what is typed, and an emptied editor as an empty string", () => {
		const { onChange, rerender } = renderEditor({ id: "desc", ariaRequired: true, ariaDescribedBy: "help" });
		expect(editor()).toHaveAttribute("id", "desc");
		expect(editor()).toHaveAttribute("aria-required", "true");
		expect(editor()).toHaveAttribute("aria-describedby", "help");
		expect(editor()).toHaveAttribute("contenteditable", "true");

		editor().innerHTML = "<p>Fix the login</p>";
		fireEvent.input(editor());
		expect(onChange).toHaveBeenLastCalledWith("<p>Fix the login</p>");
		expect(screen.queryByText("Describe the task")).not.toBeInTheDocument();

		// The value coming back is the one just emitted: the DOM is left alone.
		editor().innerHTML = "<p>Fix the login<br></p>";
		rerender(
			<RichTextEditor value="<p>Fix the login</p>" onChange={onChange} placeholder="Describe the task" />,
		);
		expect(editor().innerHTML).toBe("<p>Fix the login<br></p>");

		editor().innerHTML = "<p> </p>";
		fireEvent.blur(editor());
		expect(onChange).toHaveBeenLastCalledWith("");
		expect(screen.getByText("Describe the task")).toBeInTheDocument();
	});

	it("formats the selection from the toolbar and shows the active styles", () => {
		const { onChange } = renderEditor({ value: "<p>word</p>" });
		const text = editor().querySelector("p")?.firstChild as Text;
		select(text, 0, 4);
		queryCommandState.mockImplementation((command) => command === "bold");

		// Pressing a tool keeps the selection in the text.
		expect(fireEvent.mouseDown(tool("Bold"))).toBe(false);
		fireEvent.click(tool("Bold"));
		expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
		expect(editor()).toHaveFocus();
		expect(onChange).toHaveBeenCalledWith("<p>word</p>");
		expect(tool("Bold")).toHaveAttribute("aria-pressed", "true");
		expect(tool("Italic")).toHaveAttribute("aria-pressed", "false");

		for (const [name, command] of [
			["Italic", "italic"],
			["Underline", "underline"],
			["Bullet list", "insertUnorderedList"],
			["Numbered list", "insertOrderedList"],
		]) {
			fireEvent.click(tool(name));
			expect(execCommand).toHaveBeenLastCalledWith(command, false, undefined);
		}

		fireEvent.click(tool("Clear formatting"));
		expect(execCommand).toHaveBeenCalledWith("removeFormat", false, undefined);
		expect(execCommand).toHaveBeenLastCalledWith("unlink", false, undefined);
	});

	it("follows the caret, and ignores selections elsewhere or a detached one", () => {
		render(
			<>
				<p>Outside</p>
				<RichTextEditor value="<p>inside</p>" onChange={vi.fn()} />
			</>,
		);
		queryCommandState.mockImplementation((command) => command === "italic");
		select(screen.getByText("Outside").firstChild as Text, 0);
		act(() => {
			document.dispatchEvent(new Event("selectionchange"));
		});
		expect(queryCommandState).not.toHaveBeenCalled();

		select(editor().querySelector("p")?.firstChild as Text, 2);
		fireEvent.keyUp(editor());
		expect(tool("Italic")).toHaveAttribute("aria-pressed", "true");

		queryCommandState.mockImplementation(() => {
			throw new Error("detached");
		});
		fireEvent.mouseUp(editor());
		expect(tool("Italic")).toHaveAttribute("aria-pressed", "true");
	});

	it("links the selected words to the address typed", async () => {
		const { onChange } = renderEditor({ value: "<p>the docs</p>" });
		select(editor().querySelector("p")?.firstChild as Text, 4, 8);
		fireEvent.mouseDown(tool("Insert link"));
		const field = await screen.findByPlaceholderText("https://...");
		expect(field).toHaveValue("");
		fireEvent.change(field, { target: { value: "  https://example.test/docs " } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(execCommand).toHaveBeenCalledWith("createLink", false, "https://example.test/docs");
		expect(onChange).toHaveBeenCalled();
		expect(screen.queryByPlaceholderText("https://...")).not.toBeInTheDocument();
		// The words picked are the ones selected again before the command.
		expect(window.getSelection()?.toString()).toBe("docs");
	});

	it("inserts the address itself when nothing is selected, escaped", async () => {
		renderEditor({ value: "<p>text</p>" });
		select(editor().querySelector("p")?.firstChild as Text, 2);
		fireEvent.mouseDown(tool("Insert link"));
		fireEvent.change(await screen.findByPlaceholderText("https://..."), {
			target: { value: 'https://example.test/?q="a"&b=<c>' },
		});
		fireEvent.submit(screen.getByRole("button", { name: "Apply" }));
		expect(execCommand).toHaveBeenCalledWith(
			"insertHTML",
			false,
			'<a href="https://example.test/?q=&quot;a&quot;&amp;b=&lt;c&gt;">https://example.test/?q=&quot;a&quot;&amp;b=&lt;c&gt;</a>',
		);
	});

	it("inserts the address when the editor had no selection at all", async () => {
		renderEditor({ value: "<p>text</p>" });
		fireEvent.mouseDown(tool("Insert link"));
		fireEvent.change(await screen.findByPlaceholderText("https://..."), {
			target: { value: "https://example.test" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "Apply" }));
		expect(execCommand).toHaveBeenCalledWith(
			"insertHTML",
			false,
			'<a href="https://example.test">https://example.test</a>',
		);
	});

	it("edits an existing link, and removes it when the address is emptied", async () => {
		renderEditor({ value: '<p><a href="https://old.example.test">old</a> and <a>bare</a></p>' });
		select(screen.getByText("old").firstChild as Text, 1);
		fireEvent.mouseDown(tool("Insert link"));
		const field = await screen.findByPlaceholderText("https://...");
		expect(field).toHaveValue("https://old.example.test");
		fireEvent.change(field, { target: { value: "   " } });
		fireEvent.submit(field);
		expect(execCommand).toHaveBeenCalledWith("unlink");

		select(screen.getByText("bare").firstChild as Text, 1);
		fireEvent.mouseDown(tool("Insert link"));
		expect(await screen.findByPlaceholderText("https://...")).toHaveValue("");
	});

	it("forgets the address typed when the link box is dismissed", async () => {
		renderEditor({ value: "<p>text</p>" });
		fireEvent.mouseDown(tool("Insert link"));
		const field = await screen.findByPlaceholderText("https://...");
		fireEvent.change(field, { target: { value: "https://draft.example.test" } });
		fireEvent.keyDown(field, { key: "Escape" });
		expect(screen.queryByPlaceholderText("https://...")).not.toBeInTheDocument();
		fireEvent.mouseDown(tool("Insert link"));
		expect(await screen.findByPlaceholderText("https://...")).toHaveValue("");
	});

	it("is read-only while disabled and highlights a drop only when enabled", () => {
		const handlers = {
			onPaste: vi.fn(),
			onDragOver: vi.fn(),
			onDragLeave: vi.fn(),
			onDrop: vi.fn(),
		};
		const { container, rerender } = render(
			<RichTextEditor value="" onChange={vi.fn()} isDragOver {...handlers} />,
		);
		expect(container.firstChild).toHaveClass("border-primary");
		fireEvent.paste(editor());
		fireEvent.dragOver(editor());
		fireEvent.dragLeave(editor());
		fireEvent.drop(editor());
		for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledTimes(1);

		rerender(<RichTextEditor value="" onChange={vi.fn()} isDragOver disabled className="extra" />);
		expect(container.firstChild).not.toHaveClass("border-primary");
		expect(container.firstChild).toHaveClass("opacity-60", "extra");
		expect(editor()).toHaveAttribute("contenteditable", "false");
		expect(editor()).toHaveAttribute("tabindex", "-1");
		for (const name of ["Bold", "Italic", "Underline", "Bullet list", "Numbered list", "Insert link", "Clear formatting"]) {
			expect(tool(name)).toBeDisabled();
		}
	});
});
