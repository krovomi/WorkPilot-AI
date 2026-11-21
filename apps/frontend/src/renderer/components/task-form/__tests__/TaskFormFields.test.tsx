/**
 * @vitest-environment jsdom
 */

/**
 * TaskFormFields — the fields shared by the creation wizard and the edit
 * dialog: title, description (plain or rich), reference images (paste, drop,
 * capture, thumbnails read from disk), the engine, the classification and the
 * per-task options.
 *
 * Mocked: `electronAPI` (the boundary), and two heavy components of another
 * folder (the agent profile selector and the screen capture dialog). jsdom
 * decodes no image, so `Image` fails to load, as it does for an undecodable
 * file: the thumbnail is then the data URL itself.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, createRef, useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { ImageAttachment } from "../../../../shared/types";
import { usePromptOptimizerStore } from "../../../stores/prompt-optimizer-store";
import { TaskFormFields } from "../TaskFormFields";

vi.mock("../../AgentProfileSelector", () => ({
	AgentProfileSelector: ({ provider }: { provider?: string }) => (
		<div data-testid="agent-profile">{provider ?? "global provider"}</div>
	),
}));

vi.mock("../../ScreenshotCapture", () => ({
	ScreenshotCapture: ({
		open,
		onCapture,
	}: {
		open: boolean;
		onCapture: (data: string) => void;
	}) =>
		open ? (
			<button type="button" onClick={() => onCapture("data:image/png;base64,iVBORw0KGgo=")}>
				Take fake capture
			</button>
		) : null,
}));

class UndecodableImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	set src(_value: string) {
		setTimeout(() => this.onerror?.(), 0);
	}
}

const api = {
	loadImageThumbnail: vi.fn(),
	localBackendRequest: vi.fn(),
	dictationStart: vi.fn(),
	dictationCancel: vi.fn(),
	dictationTranscribe: vi.fn(),
};
const originalApi = window.electronAPI;
const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeAll(() => {
	vi.stubGlobal("Image", UndecodableImage);
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});
afterAll(() => {
	vi.unstubAllGlobals();
	(window as unknown as { electronAPI: unknown }).electronAPI = originalApi;
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
	for (const fn of Object.values(api)) fn.mockReset();
	api.localBackendRequest.mockResolvedValue({
		status: 200,
		contentType: "application/json",
		text: JSON.stringify({ providers: { openai: { hasAdapter: true, contextCompact: "emulated" } } }),
	});
	api.dictationCancel.mockResolvedValue(undefined);
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
	usePromptOptimizerStore.setState({ isOpen: false, initialPrompt: "" });
	Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
});

type Props = Parameters<typeof TaskFormFields>[0];

function image(id: string, extra: Partial<ImageAttachment> = {}): ImageAttachment {
	return { id, filename: `${id}.png`, mimeType: "image/png", size: 3, ...extra };
}

/** The form with its own state for what the person edits. */
function Harness({
	initialImages = [],
	initialDescription = "",
	onImages = vi.fn(),
	extra,
	...props
}: Partial<Props> & {
	initialImages?: ImageAttachment[];
	initialDescription?: string;
	onImages?: (images: ImageAttachment[]) => void;
	extra?: (add: (img: ImageAttachment) => void) => ReactNode;
}) {
	const [description, setDescription] = useState(initialDescription);
	const [images, setImages] = useState(initialImages);
	const [error, setError] = useState<string | null>(null);
	const [showClassification, setShowClassification] = useState(false);
	return (
		<>
			{extra?.((img) => setImages((list) => [...list, img]))}
			<TaskFormFields
				description={description}
				onDescriptionChange={setDescription}
				title=""
				onTitleChange={vi.fn()}
				profileId="auto"
				model=""
				thinkingLevel=""
				onProfileChange={vi.fn()}
				onModelChange={vi.fn()}
				onThinkingLevelChange={vi.fn()}
				onPhaseModelsChange={vi.fn()}
				onPhaseThinkingChange={vi.fn()}
				category=""
				priority=""
				complexity=""
				impact=""
				onCategoryChange={vi.fn()}
				onPriorityChange={vi.fn()}
				onComplexityChange={vi.fn()}
				onImpactChange={vi.fn()}
				showClassification={showClassification}
				onShowClassificationChange={setShowClassification}
				images={images}
				onImagesChange={(next) => {
					onImages(next);
					setImages(next);
				}}
				requireReviewBeforeCoding={false}
				onRequireReviewChange={vi.fn()}
				tddMode={false}
				onTddModeChange={vi.fn()}
				mobileTargets={[]}
				onMobileTargetsChange={vi.fn()}
				error={error}
				onError={setError}
				{...props}
			/>
		</>
	);
}

const description = () => screen.getByRole("textbox", { name: /^Description/ });
const imagesToggle = () => screen.getByRole("button", { name: /Reference Images \(optional\)/ });

function pngFile(name = "mockup.png", type = "image/png") {
	return new File([new Uint8Array([137, 80, 78, 71])], name, { type });
}

function paste(target: Element, items: { type: string; getAsFile: () => unknown }[]) {
	const event = { clipboardData: { items } };
	return fireEvent.paste(target, event);
}

function drop(target: Element, files: File[], json = "") {
	fireEvent.drop(target, {
		dataTransfer: {
			files,
			getData: (type: string) => (type === "application/json" ? json : ""),
		},
	});
}

describe("TaskFormFields — title and description", () => {
	it("edits the title and the description, with the default placeholder", () => {
		const onTitleChange = vi.fn();
		render(<Harness onTitleChange={onTitleChange} idPrefix="create" />);
		fireEvent.change(screen.getByLabelText(/Task Title/), { target: { value: "Login" } });
		expect(onTitleChange).toHaveBeenCalledWith("Login");
		expect(screen.getByLabelText(/Task Title/)).toHaveAttribute("id", "create-title");
		expect(description()).toHaveAttribute(
			"placeholder",
			expect.stringMatching(/^Describe the feature, bug fix, or improvement/),
		);
		fireEvent.change(description(), { target: { value: "Fix the login" } });
		expect(description()).toHaveValue("Fix the login");
	});

	it("names the paste shortcut of the platform", () => {
		render(<Harness />);
		expect(
			screen.getByText("Tip: Paste screenshots directly with Ctrl+V to add reference images."),
		).toBeInTheDocument();
		cleanup();
		Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
		render(<Harness />);
		expect(
			screen.getByText("Tip: Paste screenshots directly with ⌘V to add reference images."),
		).toBeInTheDocument();
	});

	it("hands the description to the prompt optimizer, which can write it back", () => {
		render(<Harness descriptionPlaceholder="What should change?" />);
		expect(description()).toHaveAttribute("placeholder", "What should change?");
		const optimize = screen.getByRole("button", { name: "AI Prompt Optimizer" });
		expect(optimize).toBeDisabled();
		fireEvent.change(description(), { target: { value: "  " } });
		expect(optimize).toBeDisabled();
		fireEvent.change(description(), { target: { value: "Speed up search" } });
		fireEvent.click(optimize);
		const state = usePromptOptimizerStore.getState();
		expect(state.isOpen).toBe(true);
		expect(state.initialPrompt).toBe("Speed up search");
		act(() => state.applyTarget?.("Make search answer in under 100 ms"));
		expect(description()).toHaveValue("Make search answer in under 100 ms");
	});

	it("shows an overlay, extra children and uses the caller's textarea ref", () => {
		const ref = createRef<HTMLTextAreaElement>();
		render(
			<Harness descriptionOverlay={<div>Mention overlay</div>} descriptionRef={ref}>
				<div>Mention popup</div>
			</Harness>,
		);
		expect(screen.getByText("Mention overlay")).toBeInTheDocument();
		expect(screen.getByText("Mention popup")).toBeInTheDocument();
		expect(ref.current).toBe(description());
		expect(description()).toHaveClass("bg-transparent");
	});

	it("renders a rich description when asked, and shows a form error", () => {
		render(<Harness richText initialDescription="<p>Imported <b>item</b></p>" error="Please provide a description" />);
		expect(description()).toHaveAttribute("contenteditable", "true");
		expect(description()).toHaveTextContent("Imported item");
		expect(screen.getByRole("alert")).toHaveTextContent("Please provide a description");
	});
});

describe("TaskFormFields — reference images", () => {
	it("opens the section, lists the images and counts them", () => {
		render(<Harness initialImages={[image("a", { thumbnail: "data:image/png;base64,AA" }), image("b")]} />);
		expect(screen.queryByText(/Add visual references/)).not.toBeInTheDocument();
		expect(within(imagesToggle()).getByText("2")).toBeInTheDocument();
		fireEvent.click(imagesToggle());
		expect(imagesToggle()).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText(/Add visual references/)).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "a.png" })).toHaveAttribute("src", "data:image/png;base64,AA");
		// No thumbnail: a placeholder, still a button that opens the preview.
		expect(screen.getByRole("button", { name: "Preview of b.png" })).not.toContainElement(
			screen.queryByRole("img", { name: "b.png" }),
		);
		fireEvent.click(imagesToggle());
		expect(screen.queryByText(/Add visual references/)).not.toBeInTheDocument();
	});

	it("says how to add one when there is none", () => {
		render(<Harness />);
		fireEvent.click(imagesToggle());
		expect(screen.getByText("Drag & drop images or paste screenshots")).toBeInTheDocument();
	});

	it("previews an image from a keyboard-reachable button, and removes one", () => {
		const onImages = vi.fn();
		render(<Harness onImages={onImages} initialImages={[image("a", { data: "QUFB" }), image("b")]} />);
		fireEvent.click(imagesToggle());
		fireEvent.click(screen.getByRole("button", { name: "Preview of a.png" }));
		const preview = screen.getByRole("dialog", { name: "a.png" });
		expect(within(preview).getByRole("img")).toHaveAttribute("src", "data:image/png;base64,QUFB");
		fireEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Remove image b.png" }));
		expect(onImages).toHaveBeenLastCalledWith([expect.objectContaining({ id: "a" })]);
		expect(screen.queryByRole("button", { name: "Preview of b.png" })).not.toBeInTheDocument();
	});

	it("offers no removal while the form is busy", () => {
		render(<Harness disabled initialImages={[image("a")]} />);
		expect(imagesToggle()).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Remove image a.png" })).not.toBeInTheDocument();
	});

	it("adds a pasted screenshot, opens the section and confirms for a moment", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
		const onImages = vi.fn();
		render(<Harness onImages={onImages} />);
		const ignored = paste(description(), [{ type: "text/plain", getAsFile: () => null }]);
		expect(ignored).toBe(true);
		expect(onImages).not.toHaveBeenCalled();

		const handled = paste(description(), [{ type: "image/png", getAsFile: () => pngFile("image.png") }]);
		expect(handled).toBe(false);
		expect(await screen.findByText("Image added successfully!")).toBeInTheDocument();
		const [added] = onImages.mock.calls[0][0] as ImageAttachment[];
		expect(added.filename).toMatch(/^screenshot-\d+\.png$/);
		expect(added.data).toBe("iVBORw==");
		expect(added.thumbnail).toBe("data:image/png;base64,iVBORw==");
		expect(screen.getByText(/Add visual references/)).toBeInTheDocument();

		paste(description(), [{ type: "image/svg+xml", getAsFile: () => pngFile("x", "image/svg+xml") }]);
		await waitFor(() => expect(onImages).toHaveBeenCalledTimes(2));
		expect((onImages.mock.calls[1][0] as ImageAttachment[])[1].filename).toMatch(/^screenshot-\d+\.svg$/);

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.queryByText("Image added successfully!")).not.toBeInTheDocument();
	});

	it("refuses an image type it cannot store, and skips an empty item", async () => {
		const onImages = vi.fn();
		render(<Harness onImages={onImages} />);
		paste(description(), [
			{ type: "image/png", getAsFile: () => null },
			{ type: "image/tiff", getAsFile: () => pngFile("scan.tiff", "image/tiff") },
		]);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Invalid image type. Allowed: PNG, JPEG, GIF, WebP, SVG",
		);
		expect(onImages).not.toHaveBeenCalled();
	});

	it("says how many images a task may hold once it is full", async () => {
		const full = Array.from({ length: 10 }, (_, i) => image(`i${i}`));
		render(<Harness initialImages={full} />);
		paste(description(), [{ type: "image/png", getAsFile: () => pngFile() }]);
		expect(await screen.findByRole("alert")).toHaveTextContent("Maximum of 10 images allowed");
	});

	it("says when a pasted or dropped image cannot be read", async () => {
		vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
			setTimeout(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>), 0);
		});
		render(<Harness />);
		paste(description(), [{ type: "image/png", getAsFile: () => pngFile() }]);
		expect(await screen.findByRole("alert")).toHaveTextContent("Failed to process pasted image");
		drop(description(), [pngFile()]);
		expect(await screen.findByText("Failed to process dropped image")).toBeInTheDocument();
	});

	it("keeps a dropped file's name, made unique, and ignores files that are not images", async () => {
		const onImages = vi.fn();
		render(<Harness onImages={onImages} initialImages={[image("mockup", { filename: "mockup.png" })]} />);
		fireEvent.dragOver(description());
		expect(description()).toHaveClass("border-primary");
		fireEvent.dragLeave(description());
		expect(description()).not.toHaveClass("border-primary");

		drop(description(), [new File(["x"], "notes.txt", { type: "text/plain" })]);
		drop(description(), [pngFile("mockup.png"), pngFile("")]);
		await waitFor(() => expect(onImages).toHaveBeenCalledTimes(1));
		const names = (onImages.mock.calls[0][0] as ImageAttachment[]).map((img) => img.filename);
		expect(names[0]).toBe("mockup.png");
		expect(names[1]).toMatch(/^mockup-\d+\.png$/);
		expect(names[2]).toMatch(/^screenshot-\d+\.png$/);
	});

	it("takes only as many images as the task still has room for", async () => {
		const onImages = vi.fn();
		const nine = Array.from({ length: 9 }, (_, i) => image(`i${i}`));
		render(<Harness onImages={onImages} initialImages={nine} />);
		drop(description(), [pngFile("one.png"), pngFile("two.png")]);
		await waitFor(() => expect(onImages).toHaveBeenCalled());
		const list = onImages.mock.calls[0][0] as ImageAttachment[];
		expect(list).toHaveLength(10);
		expect(list[9].filename).toBe("one.png");
	});

	it("keeps an image added elsewhere while a dropped one is read", async () => {
		const onImages = vi.fn();
		render(
			<Harness
				onImages={onImages}
				extra={(add) => (
					<button type="button" onClick={() => add(image("captured"))}>
						Add elsewhere
					</button>
				)}
			/>,
		);
		drop(description(), [pngFile("dropped.png")]);
		fireEvent.click(screen.getByRole("button", { name: "Add elsewhere" }));
		await waitFor(() => expect(onImages).toHaveBeenCalled());
		expect((onImages.mock.calls[0][0] as ImageAttachment[]).map((img) => img.filename)).toEqual([
			"captured.png",
			"dropped.png",
		]);
	});

	it("adds nothing when the task filled up while the image was read", async () => {
		const onImages = vi.fn();
		const nine = Array.from({ length: 9 }, (_, i) => image(`i${i}`));
		render(
			<Harness
				onImages={onImages}
				initialImages={nine}
				extra={(add) => (
					<button type="button" onClick={() => add(image("tenth"))}>
						Add elsewhere
					</button>
				)}
			/>,
		);
		drop(description(), [pngFile("late.png")]);
		fireEvent.click(screen.getByRole("button", { name: "Add elsewhere" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Maximum of 10 images allowed");
		expect(onImages).not.toHaveBeenCalled();
	});

	it("turns a file dragged from the file tree into a reference, not an image", () => {
		const onFileReferenceDrop = vi.fn();
		render(<Harness onFileReferenceDrop={onFileReferenceDrop} />);
		drop(
			description(),
			[pngFile()],
			JSON.stringify({ type: "file-reference", path: "/repo/src/app.ts", name: "app.ts" }),
		);
		expect(onFileReferenceDrop).toHaveBeenCalledWith("@app.ts", {
			type: "file-reference",
			path: "/repo/src/app.ts",
			name: "app.ts",
			isDirectory: false,
		});
	});

	it("ignores a drop while the form is busy", async () => {
		const onImages = vi.fn();
		render(<Harness onImages={onImages} disabled />);
		paste(description(), [{ type: "image/png", getAsFile: () => pngFile() }]);
		drop(description(), [pngFile()]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onImages).not.toHaveBeenCalled();
	});

	it("attaches a captured screenshot as a PNG main can decode", async () => {
		const onImages = vi.fn();
		render(<Harness onImages={onImages} />);
		fireEvent.click(imagesToggle());
		fireEvent.click(screen.getByRole("button", { name: "Capture" }));
		fireEvent.click(screen.getByRole("button", { name: "Take fake capture" }));
		await waitFor(() => expect(onImages).toHaveBeenCalled());
		const [shot] = onImages.mock.calls[0][0] as ImageAttachment[];
		expect(shot).toMatchObject({
			mimeType: "image/png",
			data: "iVBORw0KGgo=",
			thumbnail: "data:image/png;base64,iVBORw0KGgo=",
			size: 9,
		});
		expect(shot.filename).toMatch(/^screenshot-\d+\.png$/);
		fireEvent.click(screen.getByRole("button", { name: `Preview of ${shot.filename}` }));
		expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
			"src",
			"data:image/png;base64,iVBORw0KGgo=",
		);
	});

	it("refuses a capture once the task holds its maximum", async () => {
		const full = Array.from({ length: 10 }, (_, i) => image(`i${i}`));
		render(<Harness initialImages={full} />);
		fireEvent.click(imagesToggle());
		fireEvent.click(screen.getByRole("button", { name: "Capture" }));
		fireEvent.click(screen.getByRole("button", { name: "Take fake capture" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Maximum of 10 images allowed");
	});
});

describe("TaskFormFields — thumbnails read from disk", () => {
	it("loads the thumbnail of a saved image once", async () => {
		api.loadImageThumbnail.mockResolvedValue({ success: true, data: "data:image/png;base64,TT" });
		const onImages = vi.fn();
		render(
			<Harness
				projectPath="/work/app"
				specId="001-login"
				onImages={onImages}
				initialImages={[image("saved", { path: "attachments/saved.png" }), image("fresh", { thumbnail: "data:x" })]}
			/>,
		);
		fireEvent.click(imagesToggle());
		await waitFor(() =>
			expect(screen.getByRole("img", { name: "saved.png" })).toHaveAttribute("src", "data:image/png;base64,TT"),
		);
		expect(api.loadImageThumbnail).toHaveBeenCalledTimes(1);
		expect(api.loadImageThumbnail).toHaveBeenCalledWith("/work/app", "001-login", "attachments/saved.png");
	});

	it("keeps the placeholder when a thumbnail cannot be read, without asking again", async () => {
		api.loadImageThumbnail
			.mockResolvedValueOnce({ success: false, error: "missing" })
			.mockRejectedValueOnce(new Error("gone"));
		const onImages = vi.fn();
		render(
			<Harness
				projectPath="/work/app"
				specId="001-login"
				onImages={onImages}
				initialImages={[image("a", { path: "a.png" }), image("b", { path: "b.png" })]}
				extra={(add) => (
					<button type="button" onClick={() => add(image("c", { thumbnail: "data:c" }))}>
						Add elsewhere
					</button>
				)}
			/>,
		);
		await waitFor(() => expect(api.loadImageThumbnail).toHaveBeenCalledTimes(2));
		await act(async () => Promise.resolve());
		fireEvent.click(screen.getByRole("button", { name: "Add elsewhere" }));
		await act(async () => Promise.resolve());
		expect(api.loadImageThumbnail).toHaveBeenCalledTimes(2);
		expect(onImages).toHaveBeenCalledTimes(0);
	});

	it("still loads a thumbnail when the list changes while it is read", async () => {
		let answer!: (value: { success: boolean; data: string }) => void;
		api.loadImageThumbnail
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						answer = resolve;
					}),
			)
			.mockResolvedValue({ success: true, data: "data:image/png;base64,LATE" });
		render(
			<Harness
				projectPath="/work/app"
				specId="001-login"
				initialImages={[image("saved", { path: "saved.png" })]}
				extra={(add) => (
					<button type="button" onClick={() => add(image("other", { thumbnail: "data:o" }))}>
						Add elsewhere
					</button>
				)}
			/>,
		);
		await waitFor(() => expect(api.loadImageThumbnail).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: "Add elsewhere" }));
		await act(async () => answer({ success: true, data: "data:image/png;base64,FIRST" }));
		// The section opened by itself when the image was added.
		await waitFor(() =>
			expect(screen.getByRole("img", { name: "saved.png" })).toHaveAttribute(
				"src",
				"data:image/png;base64,LATE",
			),
		);
		expect(screen.getByRole("img", { name: "other.png" })).toBeInTheDocument();
	});

	it("reads nothing without a project and a spec", async () => {
		render(<Harness projectPath="/work/app" initialImages={[image("saved", { path: "saved.png" })]} />);
		await act(async () => Promise.resolve());
		expect(api.loadImageThumbnail).not.toHaveBeenCalled();
	});
});

describe("TaskFormFields — engine and options", () => {
	it("isolates the engine on its own step, with a heading", () => {
		render(<Harness section="engine" />);
		expect(screen.getByRole("heading", { name: "Execution engine" })).toBeInTheDocument();
		expect(screen.getByText(/Choose the provider, model and effort/)).toBeInTheDocument();
		expect(screen.getByLabelText(/Task Title/).closest(".hidden")).not.toBeNull();
		expect(screen.getByTestId("agent-profile").closest(".hidden")).toBeNull();
		expect(screen.getByRole("button", { name: "Dictate" })).toBeDisabled();
	});

	it("hides the engine on the content step", () => {
		render(<Harness section="content" />);
		expect(screen.queryByRole("heading", { name: "Execution engine" })).not.toBeInTheDocument();
		expect(screen.getByTestId("agent-profile").closest(".hidden")).not.toBeNull();
		expect(screen.getByLabelText(/Task Title/).closest(".hidden")).toBeNull();
	});

	it("offers a provider per task when the form saves one", async () => {
		const onProviderChange = vi.fn();
		const { rerender } = render(<Harness />);
		expect(screen.queryByText("Provider")).not.toBeInTheDocument();
		expect(screen.getByTestId("agent-profile")).toHaveTextContent("global provider");

		rerender(<Harness provider="openai" onProviderChange={onProviderChange} />);
		const select = screen.getByRole("combobox", { name: "Provider" });
		expect(select).toHaveTextContent("OpenAI (ChatGPT)");
		expect(screen.getByTestId("agent-profile")).toHaveTextContent("openai");
		fireEvent.keyDown(select, { key: "Enter" });
		expect(screen.queryByRole("option", { name: "Custom" })).not.toBeInTheDocument();
		fireEvent.click(await screen.findByRole("option", { name: "Anthropic (Claude)" }));
		expect(onProviderChange).toHaveBeenCalledWith("anthropic");

		rerender(<Harness provider="" onProviderChange={onProviderChange} />);
		expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("Select a provider");
	});

	it("lets the task's engine editor replace the provider and profile", () => {
		render(<Harness onProviderChange={vi.fn()} engineSlot={<div>Engine editor</div>} />);
		expect(screen.getByText("Engine editor")).toBeInTheDocument();
		expect(screen.queryByTestId("agent-profile")).not.toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument();
	});

	it("opens the classification and edits the review and TDD options", () => {
		const onRequireReviewChange = vi.fn();
		const onTddModeChange = vi.fn();
		render(<Harness onRequireReviewChange={onRequireReviewChange} onTddModeChange={onTddModeChange} />);
		const toggle = screen.getByRole("button", { name: "Classification (optional)" });
		expect(screen.queryByText("Select category")).not.toBeInTheDocument();
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Select category")).toBeInTheDocument();
		fireEvent.click(toggle);
		expect(screen.queryByText("Select category")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("checkbox", { name: "Require human review before coding" }));
		expect(onRequireReviewChange).toHaveBeenCalledWith(true);
		fireEvent.click(screen.getByRole("checkbox", { name: "Strict TDD mode (Red-Green-Refactor)" }));
		expect(onTddModeChange).toHaveBeenCalledWith(true);
	});

	it("shows the optional per-task fields only when the form saves them", async () => {
		const onMobileTargetsChange = vi.fn();
		const { rerender } = render(<Harness onMobileTargetsChange={onMobileTargetsChange} />);
		expect(screen.queryByText("Split automatically when the task is too big")).not.toBeInTheDocument();
		expect(screen.queryByText("Verification loop")).not.toBeInTheDocument();
		expect(screen.queryByText("Context memory")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("checkbox", { name: "Android" }));
		expect(onMobileTargetsChange).toHaveBeenCalledWith(["android"]);

		rerender(
			<Harness
				onMobileTargetsChange={onMobileTargetsChange}
				autoSplit={{ noSplit: false, maxLines: "" }}
				onAutoSplitChange={vi.fn()}
				autoSplitProjectMaxLines={300}
				onVerifyLoopChange={vi.fn()}
				contextPolicy={{ mode: "auto", thresholdPct: 50, prepareHandoff: true }}
				onContextPolicyChange={vi.fn()}
				contextProvider="openai"
			/>,
		);
		expect(screen.getByText("Split automatically when the task is too big")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("300 (project, Feature)")).toBeInTheDocument();
		expect(screen.getByText("Verification loop")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show context settings" }));
		expect(await screen.findByText("OpenAI (ChatGPT): compaction emulated by summary")).toBeInTheDocument();
	});
});
