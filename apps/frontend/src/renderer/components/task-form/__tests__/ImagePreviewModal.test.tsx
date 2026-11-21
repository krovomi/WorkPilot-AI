/**
 * @vitest-environment jsdom
 */

/**
 * ImagePreviewModal — an attached image, enlarged: the full image when its
 * data is there, else the thumbnail with a "low resolution" note, else a
 * placeholder.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { ImageAttachment } from "../../../../shared/types";
import { ImagePreviewModal } from "../ImagePreviewModal";

const IMAGE: ImageAttachment = {
	id: "img-1",
	filename: "login-page.png",
	mimeType: "image/png",
	size: 4,
};

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("ImagePreviewModal", () => {
	it("renders nothing without an image", () => {
		const { container } = render(
			<ImagePreviewModal open onOpenChange={vi.fn()} image={null} />,
		);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("shows the full image when its data is there", () => {
		render(
			<ImagePreviewModal
				open
				onOpenChange={vi.fn()}
				image={{ ...IMAGE, data: "AAAA", thumbnail: "data:image/jpeg;base64,BBBB" }}
			/>,
		);
		const dialog = screen.getByRole("dialog", { name: "login-page.png" });
		expect(dialog).toHaveAccessibleDescription("Preview of login-page.png");
		expect(screen.getByRole("img", { name: "login-page.png" })).toHaveAttribute(
			"src",
			"data:image/png;base64,AAAA",
		);
		expect(screen.queryByText("Low resolution preview")).not.toBeInTheDocument();
	});

	it("falls back to the thumbnail and says it is a low resolution", () => {
		render(
			<ImagePreviewModal
				open
				onOpenChange={vi.fn()}
				image={{ ...IMAGE, thumbnail: "data:image/jpeg;base64,BBBB" }}
			/>,
		);
		expect(screen.getByRole("img", { name: "login-page.png" })).toHaveAttribute(
			"src",
			"data:image/jpeg;base64,BBBB",
		);
		expect(screen.getByText("Low resolution preview")).toBeInTheDocument();
	});

	it("says the image is unavailable, and closes from its button", () => {
		const onOpenChange = vi.fn();
		render(<ImagePreviewModal open onOpenChange={onOpenChange} image={IMAGE} />);
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("Image unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
