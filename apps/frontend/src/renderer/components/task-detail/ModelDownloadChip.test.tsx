/**
 * ModelDownloadChip — the download state of a phase's local model, next to
 * its model picker. Real i18n; the handlers are the only stand-ins.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { DownloadProgress } from "../../stores/download-store";
import { ModelDownloadChip } from "./ModelDownloadChip";

function renderChip(
	props: Partial<Parameters<typeof ModelDownloadChip>[0]> = {},
) {
	const handlers = {
		onDownload: vi.fn(),
		onCancel: vi.fn(),
		onDismiss: vi.fn(),
	};
	const utils = render(
		<ModelDownloadChip model="qwen3:8b" {...handlers} {...props} />,
	);
	return { ...utils, ...handlers };
}

function progress(overrides: Partial<DownloadProgress> = {}): DownloadProgress {
	return {
		modelName: "qwen3:8b",
		status: "downloading",
		percentage: 42,
		...overrides,
	};
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("ModelDownloadChip — downloading", () => {
	it("shows the percentage, the speed and the time left, and cancels", () => {
		const { container, onCancel } = renderChip({
			download: progress({ speed: "12.0 MB/s", secondsRemaining: 150 }),
		});
		expect(screen.getByText("42%")).toBeInTheDocument();
		expect(container.firstElementChild).toHaveAttribute(
			"title",
			"Downloading “qwen3:8b” · 12.0 MB/s · 3m remaining",
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("words the time left in the app's language", async () => {
		await i18n.changeLanguage("fr");
		const { container } = renderChip({
			download: progress({ secondsRemaining: 7200 }),
		});
		expect(container.firstElementChild).toHaveAttribute(
			"title",
			"Téléchargement de « qwen3:8b » · encore 2 h",
		);
	});

	it("says it is queued before the first byte, without speed or estimate", () => {
		const { container } = renderChip({
			download: progress({ status: "starting", percentage: 0 }),
		});
		expect(screen.getByText("queued…")).toBeInTheDocument();
		expect(container.firstElementChild).toHaveAttribute(
			"title",
			"Downloading “qwen3:8b”",
		);
	});
});

describe("ModelDownloadChip — finished states", () => {
	it("offers a retry after a failure, with the error as its tip", () => {
		const { onDownload } = renderChip({
			download: progress({ status: "failed", error: "disk full" }),
		});
		const retry = screen.getByRole("button", { name: "Retry download" });
		expect(retry).toHaveAttribute("title", "disk full");
		fireEvent.click(retry);
		expect(onDownload).toHaveBeenCalledTimes(1);
	});

	it("explains the retry when the failure carried no message", () => {
		renderChip({ download: progress({ status: "failed" }) });
		expect(
			screen.getByRole("button", { name: "Retry download" }),
		).toHaveAttribute("title", "Retry download");
	});

	it("stays Ready after the pull until dismissed", () => {
		const { onDismiss } = renderChip({
			installed: false,
			download: progress({ status: "completed", percentage: 100 }),
		});
		const ready = screen.getByRole("button", { name: "Ready" });
		expect(ready).toHaveAttribute(
			"title",
			"qwen3:8b is installed and ready to use.",
		);
		fireEvent.click(ready);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("shows nothing once the catalog lists the downloaded model", () => {
		const { container } = renderChip({
			installed: true,
			download: progress({ status: "completed", percentage: 100 }),
		});
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ModelDownloadChip — idle", () => {
	it("shows nothing while the catalog has not answered", () => {
		const { container } = renderChip();
		expect(container).toBeEmptyDOMElement();
	});

	it("offers the download of a missing model", () => {
		const { onDownload } = renderChip({ installed: false });
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(onDownload).toHaveBeenCalledTimes(1);
	});
});
