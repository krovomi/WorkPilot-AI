/**
 * Images pasted or dropped into the changelog text: each is saved through the
 * main process and its Markdown inserted at the cursor; a refused type or a
 * failed save shows a translated error.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImageUpload } from "../useImageUpload";

const save = vi.fn();
const onContentChange = vi.fn();

beforeEach(() => {
	save.mockReset().mockResolvedValue({ success: true, data: { relativePath: "assets/x.png" } });
	onContentChange.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = { saveChangelogImage: save };
	vi.spyOn(Date, "now").mockReturnValue(1000);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function mounted(projectId: string | null = "p1", content = "ab") {
	const hook = renderHook(() => useImageUpload({ projectId, content, onContentChange }));
	const textarea = document.createElement("textarea");
	textarea.value = content;
	document.body.replaceChildren(textarea);
	textarea.setSelectionRange(1, 1);
	hook.result.current.textareaRef.current = textarea;
	return { ...hook, textarea };
}

const image = (type = "image/png", name = "shot.png") => new File(["x"], name, { type });

function paste(files: Array<File | null>, types?: string[]) {
	const preventDefault = vi.fn();
	const items = files.map((file, i) => ({ type: types?.[i] ?? file?.type ?? "", getAsFile: () => file }));
	return { event: { clipboardData: { items }, preventDefault } as never, preventDefault };
}

function drag(files: File[] = []) {
	const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { files } };
	return event as never as Parameters<ReturnType<typeof useImageUpload>["handleDrop"]>[0] & typeof event;
}

describe("pasting", () => {
	it("saves a pasted image and inserts it at the cursor, then moves the cursor after it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		const { result, textarea } = mounted();
		const { event, preventDefault } = paste([image()]);
		await act(() => result.current.handlePaste(event));

		expect(preventDefault).toHaveBeenCalled();
		const dataUrl = save.mock.calls[0][1];
		expect(save).toHaveBeenCalledWith("p1", dataUrl, "changelog-1000.png");
		expect(dataUrl).toMatch(/^data:image\/png;base64,/);
		const inserted = "\n![changelog-1000.png](assets/x.png)\n";
		expect(onContentChange).toHaveBeenCalledWith(`a${inserted}b`);

		textarea.value = `a${inserted}b`; // the editor renders the new content
		act(() => vi.runAllTimers());
		expect(textarea.selectionStart).toBe(1 + inserted.length);
		expect(document.activeElement).toBe(textarea);
	});

	it("names a file by its type, whatever the name it came with", async () => {
		const { result } = mounted();
		await act(() => result.current.handlePaste(paste([image("image/svg+xml", "image")]).event));
		await act(() => result.current.handlePaste(paste([image("image/jpeg", "Photo.JPEG")]).event));
		expect(save.mock.calls.map((call) => call[2])).toEqual(["changelog-1000.svg", "changelog-1000.jpg"]);
	});

	it("leaves a paste without an image to the textarea", async () => {
		const { result } = mounted();
		const { event, preventDefault } = paste([], []);
		await act(() => result.current.handlePaste(event));
		expect(preventDefault).not.toHaveBeenCalled();
		await act(() => result.current.handlePaste(paste([null], ["image/png"]).event));
		expect(save).not.toHaveBeenCalled();
	});

	it("refuses an image type the changelog cannot hold", async () => {
		const { result } = mounted();
		await act(() => result.current.handlePaste(paste([image("image/bmp", "a.bmp")]).event));
		expect(save).not.toHaveBeenCalled();
		expect(result.current.imageError).toBe("Invalid image type. Allowed: PNG, JPEG, GIF, WebP, SVG");
	});

	it("shows why a save failed", async () => {
		const { result } = mounted();
		save.mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(() => result.current.handlePaste(paste([image()]).event));
		expect(result.current.imageError).toBe("disk full");

		save.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handlePaste(paste([image()]).event));
		expect(result.current.imageError).toBe("Failed to save image");

		save.mockRejectedValueOnce(new Error("ipc"));
		await act(() => result.current.handlePaste(paste([image()]).event));
		expect(result.current.imageError).toBe("Failed to process image");
		expect(onContentChange).not.toHaveBeenCalled();
	});

	it("inserts nothing before the textarea is mounted", async () => {
		const { result } = mounted();
		result.current.textareaRef.current = null;
		await act(() => result.current.handlePaste(paste([image()]).event));
		expect(save).toHaveBeenCalled();
		expect(onContentChange).not.toHaveBeenCalled();
	});

	it("does nothing without a project", async () => {
		const { result } = mounted(null);
		const { event, preventDefault } = paste([image()]);
		await act(() => result.current.handlePaste(event));
		await act(() => result.current.handleDrop(drag([image()])));
		expect(preventDefault).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});
});

describe("dragging", () => {
	it("marks the area while an image is dragged over it", () => {
		const { result } = mounted();
		const over = drag();
		act(() => result.current.handleDragOver(over));
		expect(over.preventDefault).toHaveBeenCalled();
		expect(result.current.isDragOver).toBe(true);
		act(() => result.current.handleDragLeave(drag()));
		expect(result.current.isDragOver).toBe(false);
	});

	it("saves each dropped image and ignores other files", async () => {
		const { result } = mounted();
		act(() => result.current.handleDragOver(drag()));
		await act(() => result.current.handleDrop(drag([image(), new File(["t"], "notes.txt", { type: "text/plain" }), image("image/gif", "a.gif")])));
		expect(result.current.isDragOver).toBe(false);
		expect(save.mock.calls.map((call) => call[2])).toEqual(["changelog-1000.png", "changelog-1000.gif"]);

		save.mockClear();
		await act(() => result.current.handleDrop(drag([new File(["t"], "notes.txt", { type: "text/plain" })])));
		expect(save).not.toHaveBeenCalled();
	});
});
