/**
 * QAFeedbackSection — the change request of a review: its text, the open
 * line comments that go with it, and screenshots pasted or dropped on the
 * text, within the per-task limit.
 */

import {
	act,
	cleanup,
	createEvent,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGES_PER_TASK } from "../../../../../shared/constants";
import i18n from "../../../../../shared/i18n";
import type { ImageAttachment } from "../../../../../shared/types";
import type { ReviewComment } from "../../../../../shared/types/review-comments";
import { createThumbnail } from "../../../../lib/image-attachments";
import { QAFeedbackSection } from "../QAFeedbackSection";

// jsdom never loads an image, so the thumbnail is made up.
vi.mock("../../../../lib/image-attachments", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createThumbnail: vi.fn(async () => "data:image/jpeg;base64,thumb"),
}));

const png = (name = "shot.png", type = "image/png") =>
	new File([new Uint8Array([1, 2, 3])], name, { type });

function image(id: string): ImageAttachment {
	return { id, filename: `${id}.png`, mimeType: "image/png", size: 3, data: "AQID" };
}

type Props = Parameters<typeof QAFeedbackSection>[0];
type ImagesChange = (images: ImageAttachment[]) => void;

function renderSection(overrides: Partial<Props> = {}) {
	const props: Props = {
		feedback: "",
		isSubmitting: false,
		onFeedbackChange: vi.fn(),
		onReject: vi.fn(),
		onImagesChange: vi.fn(),
		...overrides,
	};
	const view = render(<QAFeedbackSection {...props} />);
	return { ...view, props, textarea: screen.getByRole("textbox") };
}

function paste(target: HTMLElement, files: File[], extra: { type: string }[] = []) {
	const items = [
		...files.map((file) => ({ type: file.type, getAsFile: () => file })),
		...extra.map((item) => ({ ...item, getAsFile: () => null })),
	];
	const event = createEvent.paste(target, { clipboardData: { items } });
	fireEvent(target, event);
	return event;
}

function drop(target: HTMLElement, files: File[]) {
	fireEvent.drop(target, { dataTransfer: { files } });
}

afterEach(async () => {
	cleanup();
	vi.clearAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("change request", () => {
	it("needs text, an image or an open comment before it can be sent", async () => {
		const { props, rerender } = renderSection();
		const button = screen.getByRole("button", { name: "Request Changes" });
		expect(button).toBeDisabled();
		await userEvent.type(screen.getByRole("textbox"), "x");
		expect(props.onFeedbackChange).toHaveBeenCalledWith("x");

		rerender(<QAFeedbackSection {...props} feedback="Rename it" />);
		await userEvent.click(button);
		expect(props.onReject).toHaveBeenCalledTimes(1);

		rerender(<QAFeedbackSection {...props} feedback="   " images={[image("a")]} />);
		expect(button).toBeEnabled();

		const comment = { id: "c1", status: "open", path: "src/a.ts", line: 4, text: "Typo" } as ReviewComment;
		rerender(<QAFeedbackSection {...props} reviewComments={[comment]} />);
		expect(button).toBeEnabled();
		expect(screen.getByText("src/a.ts:4")).toBeInTheDocument();
	});

	it("shows that it is being sent, in the app's language", async () => {
		await i18n.changeLanguage("fr");
		renderSection({ feedback: "x", isSubmitting: true, images: [image("a")] });
		expect(screen.getByRole("button", { name: "Envoi en cours..." })).toBeDisabled();
		expect(screen.getByRole("textbox")).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Supprimer l'image" })).toBeNull();
	});

	it("without an image handler, offers no image and pastes as text", () => {
		const { textarea } = renderSection({ onImagesChange: undefined });
		expect(screen.queryByText(/Drag & drop/)).toBeNull();
		const event = paste(textarea, [png()]);
		expect(event.defaultPrevented).toBe(false);
		drop(textarea, [png()]);
		expect(createThumbnail).not.toHaveBeenCalled();
	});
});

describe("images", () => {
	it("adds a pasted screenshot under a generated name", async () => {
		const { textarea, props } = renderSection();
		const event = paste(textarea, [png("", "image/svg+xml")], [{ type: "text/plain" }]);
		expect(event.defaultPrevented).toBe(true);
		await waitFor(() => expect(props.onImagesChange).toHaveBeenCalled());
		const [added] = vi.mocked(props.onImagesChange as ImagesChange).mock.calls[0][0];
		expect(added).toMatchObject({
			mimeType: "image/svg+xml",
			size: 3,
			data: "AQID",
			thumbnail: "data:image/jpeg;base64,thumb",
		});
		expect(added.filename).toMatch(/^screenshot-\d+\.svg$/);
		expect(await screen.findByText("Image added successfully!")).toBeInTheDocument();
	});

	it("leaves a text paste alone", () => {
		const { textarea, props } = renderSection();
		const event = paste(textarea, [], [{ type: "text/plain" }]);
		expect(event.defaultPrevented).toBe(false);
		expect(props.onImagesChange).not.toHaveBeenCalled();
	});

	it("keeps a dropped file's name, made unique next to the others", async () => {
		const { textarea, props } = renderSection({ images: [image("shot")] });
		drop(textarea, [png("shot.png"), new File(["x"], "notes.txt", { type: "text/plain" })]);
		await waitFor(() => expect(props.onImagesChange).toHaveBeenCalled());
		const next = vi.mocked(props.onImagesChange as ImagesChange).mock.calls[0][0];
		expect(next).toHaveLength(2);
		expect(next[1].filename).not.toBe("shot.png");
		expect(next[1].filename).toMatch(/^shot.*\.png$/);
	});

	it("names a dropped file that has no name", async () => {
		const { textarea, props } = renderSection();
		drop(textarea, [png("", "image/webp")]);
		await waitFor(() => expect(props.onImagesChange).toHaveBeenCalled());
		expect(vi.mocked(props.onImagesChange as ImagesChange).mock.calls[0][0][0].filename).toMatch(
			/^dropped-image-\d+\.webp$/,
		);
	});

	it("ignores a drop while sending, and a drop with no image", () => {
		const { textarea, props, rerender } = renderSection({ isSubmitting: true });
		drop(textarea, [png()]);
		rerender(<QAFeedbackSection {...props} isSubmitting={false} />);
		drop(textarea, [new File(["x"], "a.txt", { type: "text/plain" })]);
		drop(textarea, []);
		expect(props.onImagesChange).not.toHaveBeenCalled();
	});

	it("refuses an image past the limit", async () => {
		await i18n.changeLanguage("fr");
		const full = Array.from({ length: MAX_IMAGES_PER_TASK }, (_, i) => image(`i${i}`));
		const { textarea, props } = renderSection({ images: full });
		paste(textarea, [png()]);
		expect(
			await screen.findByText(`Maximum de ${MAX_IMAGES_PER_TASK} images autorisées`),
		).toBeInTheDocument();
		drop(textarea, [png()]);
		expect(props.onImagesChange).not.toHaveBeenCalled();
	});

	it("refuses a type it cannot attach and keeps the others", async () => {
		const { textarea, props } = renderSection();
		drop(textarea, [png("a.tiff", "image/tiff"), png("b.png")]);
		expect(await screen.findByText(/Invalid image type/)).toBeInTheDocument();
		await waitFor(() => expect(props.onImagesChange).toHaveBeenCalled());
		expect(vi.mocked(props.onImagesChange as ImagesChange).mock.calls[0][0].map((i) => i.filename)).toEqual([
			"b.png",
		]);
	});

	it("says when an image could not be read", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.mocked(createThumbnail).mockRejectedValueOnce(new Error("decode"));
		const { textarea, props } = renderSection();
		paste(textarea, [png()]);
		expect(await screen.findByText("Failed to process image")).toBeInTheDocument();
		expect(props.onImagesChange).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("removes an image and clears the error", async () => {
		const { props, textarea } = renderSection({ images: [image("a"), image("b")] });
		drop(textarea, [png("x.tiff", "image/tiff")]);
		expect(await screen.findByText(/Invalid image type/)).toBeInTheDocument();
		await userEvent.click(screen.getAllByRole("button", { name: "Remove image" })[0]);
		expect(props.onImagesChange).toHaveBeenCalledWith([image("b")]);
		expect(screen.queryByText(/Invalid image type/)).toBeNull();
		expect(screen.getByTitle("b.png")).toBeInTheDocument();
	});

	it("shows a thumbnail or a placeholder, and highlights a drag", () => {
		const { textarea } = renderSection({
			images: [image("a"), { ...image("b"), thumbnail: "data:image/jpeg;base64,t" }],
		});
		expect(screen.getByTitle("a.png").querySelector("img")).toBeNull();
		expect(screen.getByAltText("b.png")).toBeInTheDocument();
		fireEvent.dragOver(textarea);
		expect(textarea.className).toContain("ring-primary/20");
		fireEvent.dragLeave(textarea);
		expect(textarea.className).not.toContain("ring-primary/20");
	});

	it("hides the success note after two seconds", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { textarea, props } = renderSection();
			paste(textarea, [png()]);
			await waitFor(() => expect(props.onImagesChange).toHaveBeenCalled());
			expect(screen.getByText("Image added successfully!")).toBeInTheDocument();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2_000);
			});
			expect(screen.queryByText("Image added successfully!")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
