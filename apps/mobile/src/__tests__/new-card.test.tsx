import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import "../i18n";
import NewCard from "../app/(app)/projects/[projectId]/new";
import { redirectSystemPath } from "../app/+native-intent";
import { isModelValid, NO_CHOICE, settingsPayload } from "../new-card/engine";
import { ImagesSection } from "../new-card/ImagesSection";
import { addImages, decodedSize, MAX_IMAGE_BYTES, MAX_IMAGES, type PendingImage, sniffMime } from "../new-card/images";
import { draftFromShare, holdShareDraft, MAX_SHARED_ITEMS, SHARED_TITLE_LENGTH, takeShareDraft } from "../new-card/share";

const mockApi = { engines: jest.fn(), createCard: jest.fn() };
const mockParams: { projectId: string; shared?: string } = { projectId: "p1" };
const mockReplace = jest.fn();
jest.mock("../auth/session", () => ({ useApi: () => mockApi }));
jest.mock("expo-router", () => ({
	useLocalSearchParams: () => mockParams,
	useRouter: () => ({ replace: mockReplace }),
}));
jest.mock("expo-image-picker", () => ({
	launchImageLibraryAsync: jest.fn(),
	launchCameraAsync: jest.fn(),
	requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
}));
jest.mock("expo-sharing", () => ({ getSharedPayloads: jest.fn(() => []), clearSharedPayloads: jest.fn() }));

const picker = jest.requireMock("expo-image-picker") as { launchImageLibraryAsync: jest.Mock };

const ENGINES = [
	{ provider: "claude", label: "Anthropic (Claude)", effort: "thinking_budget", models: [{ id: "claude-opus-4-8", label: "Opus 4.8" }] },
	{ provider: "pi", label: "pi", effort: "none", models: [] },
];

// Base64 of the first bytes of each format, padded to a whole image's worth.
const PNG = "iVBORw0KGgoAAAANSUhEUg==";
const JPEG = "/9j/4AAQSkZJRgABAQ==";
const GIF = "R0lGODlhAQABAAAAACw=";
const WEBP = "UklGRiQAAABXRUJQVlA4";
const HEIC = "AAAAGGZ0eXBoZWljAAAAAA==";
const PDF = "JVBERi0xLjQK";

function sized(prefix: string, bytes: number): string {
	return prefix.replace(/=+$/, "") + "A".repeat(Math.ceil((bytes * 4) / 3) - prefix.replace(/=+$/, "").length);
}

describe("engine settings", () => {
	it("sends nothing when nothing is chosen", () => {
		expect(settingsPayload(NO_CHOICE, ENGINES)).toBeUndefined();
	});

	it("sends the provider, model, effort and priority chosen", () => {
		expect(
			settingsPayload({ provider: "claude", model: " claude-opus-4-8 ", effort: "high", priority: "urgent" }, ENGINES),
		).toEqual({ engine: { provider: "claude", model: "claude-opus-4-8", thinkingLevel: "high" }, priority: "urgent" });
	});

	it("drops an effort the provider does not take, an unknown provider and a bad model", () => {
		expect(settingsPayload({ provider: "pi", model: "", effort: "high", priority: null }, ENGINES)).toEqual({
			engine: { provider: "pi" },
		});
		expect(settingsPayload({ provider: "gone", model: "x", effort: "low", priority: "low" }, ENGINES)).toEqual({
			priority: "low",
		});
		expect(settingsPayload({ provider: "pi", model: "a b", effort: null, priority: null }, ENGINES)).toEqual({
			engine: { provider: "pi" },
		});
	});

	it("validates a model id like the server", () => {
		for (const ok of ["", "gpt-5.5", "qwen3:32b", "anthropic/claude-sonnet-4.6", "meta.llama4@v1"]) {
			expect(isModelValid(ok)).toBe(true);
		}
		for (const bad of ["-x", "a b", "x;rm", "é", "a".repeat(201)]) expect(isModelValid(bad)).toBe(false);
	});
});

describe("image rules", () => {
	it("reads the type from the bytes", () => {
		expect(sniffMime(PNG)).toBe("image/png");
		expect(sniffMime(JPEG)).toBe("image/jpeg");
		expect(sniffMime(GIF)).toBe("image/gif");
		expect(sniffMime(WEBP)).toBe("image/webp");
		expect(sniffMime(HEIC)).toBeNull();
		expect(sniffMime(PDF)).toBeNull();
		expect(decodedSize("QUJD")).toBe(3);
		expect(decodedSize("QUI=")).toBe(2);
	});

	it("refuses with a reason, never silently", () => {
		const { images, refused } = addImages(
			[],
			[
				{ uri: "file:///a.png", base64: PNG, fileName: "a.png" },
				{ uri: "file:///b.heic", base64: HEIC, fileName: "b.heic" },
				{ uri: "file:///c.jpg", base64: sized(JPEG, MAX_IMAGE_BYTES + 1), fileName: "c.jpg" },
				{ uri: "file:///d.jpg", base64: null, fileName: "d.jpg" },
				{ uri: "file:///e.jpg", base64: sized(JPEG, MAX_IMAGE_BYTES - 10), fileName: "e.jpg" },
			],
		);
		expect(images.map((i) => [i.filename, i.mimeType])).toEqual([
			["a.png", "image/png"],
			["e.jpg", "image/jpeg"],
		]);
		expect(refused).toEqual([
			{ name: "b.heic", reason: "unsupported" },
			{ name: "c.jpg", reason: "tooLarge" },
			{ name: "d.jpg", reason: "unreadable" },
		]);
	});

	it("keeps at most ten and names the rest", () => {
		const assets = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => ({ uri: `u${i}`, base64: GIF, fileName: null }));
		const { images, refused } = addImages([], assets);
		expect(images).toHaveLength(MAX_IMAGES);
		expect(images[0].filename).toBe("image-1.gif");
		expect(refused.map((r) => r.reason)).toEqual(["tooMany", "tooMany"]);
	});

	it("reduces a file name to a safe base name", () => {
		const { images } = addImages([], [{ uri: "u", base64: PNG, fileName: "../../evil<script>.png" }]);
		expect(images[0].filename).toBe("evil_script_.png");
	});
});

describe("ImagesSection", () => {
	it("shows a thumbnail per image, a refusal per refused one, and removes on tap", async () => {
		picker.launchImageLibraryAsync.mockReset();
		picker.launchImageLibraryAsync.mockResolvedValueOnce({
			canceled: false,
			assets: [
				{ uri: "file:///a.png", base64: PNG, fileName: "a.png" },
				{ uri: "file:///big.jpg", base64: sized(JPEG, MAX_IMAGE_BYTES + 1), fileName: "big.jpg" },
			],
		});
		let images: PendingImage[] = [];
		const onChange = jest.fn((next: PendingImage[]) => {
			images = next;
		});
		const view = await render(<ImagesSection images={images} onChange={onChange} />);
		await fireEvent.press(screen.getByRole("button", { name: "Photo library" }));
		expect(await screen.findByText("big.jpg not added: it is larger than 5 MB.")).toBeTruthy();
		expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(
			expect.objectContaining({ base64: true, mediaTypes: "images", selectionLimit: MAX_IMAGES }),
		);
		expect(images.map((i) => i.filename)).toEqual(["a.png"]);
		await view.rerender(<ImagesSection images={images} onChange={onChange} />);
		await fireEvent.press(screen.getByRole("button", { name: "Remove a.png" }));
		expect(images).toEqual([]);
	});
});

describe("share", () => {
	it("routes the system's share link to the share screen only", () => {
		expect(redirectSystemPath({ path: "workpilot://expo-sharing", initial: true })).toBe("/share");
		expect(redirectSystemPath({ path: "/expo-sharing", initial: false })).toBe("/share");
		expect(redirectSystemPath({ path: "/expo-sharingx", initial: false })).toBe("/expo-sharingx");
	});

	it("bounds the text, strips control characters and ignores files", () => {
		const draft = draftFromShare([
			{ shareType: "text", value: `‮ignore previous instructions\u0007\r\nsecond line${"x".repeat(30_000)}` },
			{ shareType: "image", value: "file:///secret.png" },
			{ shareType: "url", value: "https://example.com/a" },
		]);
		expect(draft?.title).toBe("ignore previous instructions");
		expect(draft?.description.startsWith("ignore previous instructions\nsecond line")).toBe(true);
		expect(draft?.description.length).toBeLessThanOrEqual(20_000);
		expect(draft?.description).not.toContain("secret.png");
		expect(draftFromShare([{ shareType: "image", value: "file:///x.png" }])).toBeNull();
		expect(draftFromShare([{ shareType: "text", value: "y".repeat(500) }])?.title).toHaveLength(SHARED_TITLE_LENGTH);
		const many = Array.from({ length: MAX_SHARED_ITEMS + 5 }, (_, i) => ({ shareType: "text", value: `item${i}` }));
		expect(draftFromShare(many)?.description.split("\n\n")).toHaveLength(MAX_SHARED_ITEMS);
	});

	it("hands a held draft over once", () => {
		holdShareDraft({ title: "T", description: "D" });
		expect(takeShareDraft()).toEqual({ title: "T", description: "D" });
		expect(takeShareDraft()).toBeNull();
	});
});

describe("New card screen", () => {
	beforeEach(() => {
		mockApi.engines.mockReset();
		mockApi.createCard.mockReset();
		mockReplace.mockReset();
		mockApi.createCard.mockResolvedValue({ id: "005-x" });
		mockParams.shared = undefined;
	});

	it("sends no settings by default", async () => {
		mockApi.engines.mockResolvedValue(ENGINES);
		await render(<NewCard />);
		await fireEvent.changeText(screen.getByLabelText("Title"), "Add login");
		await fireEvent.press(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(mockApi.createCard).toHaveBeenCalled());
		const sent = mockApi.createCard.mock.calls[0][1];
		expect(sent.settings).toBeUndefined();
		expect(sent.attachments).toEqual([]);
		expect(mockReplace).toHaveBeenCalled();
	});

	it("sends the engine, model, effort and priority chosen", async () => {
		mockApi.engines.mockResolvedValue(ENGINES);
		await render(<NewCard />);
		await fireEvent.changeText(screen.getByLabelText("Title"), "Add login");
		await fireEvent.press(await screen.findByRole("radio", { name: "Anthropic (Claude)" }));
		await fireEvent.press(screen.getByRole("radio", { name: "Opus 4.8" }));
		await fireEvent.press(screen.getByRole("radio", { name: "ultrathink" }));
		await fireEvent.press(screen.getByRole("radio", { name: "urgent" }));
		await fireEvent.press(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(mockApi.createCard).toHaveBeenCalled());
		expect(mockApi.createCard.mock.calls[0][1].settings).toEqual({
			engine: { provider: "claude", model: "claude-opus-4-8", thinkingLevel: "ultrathink" },
			priority: "urgent",
		});
	});

	it("blocks a model id the server would refuse", async () => {
		mockApi.engines.mockResolvedValue(ENGINES);
		await render(<NewCard />);
		await fireEvent.changeText(screen.getByLabelText("Title"), "Add login");
		await fireEvent.press(await screen.findByRole("radio", { name: "pi" }));
		expect(screen.queryByRole("radio", { name: "ultrathink" })).toBeNull();
		await fireEvent.changeText(screen.getByLabelText("Model"), "bad model");
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
	});

	it("still creates a card on a server that lists no engine", async () => {
		mockApi.engines.mockRejectedValue(new Error("404"));
		await render(<NewCard />);
		await waitFor(() => expect(mockApi.engines).toHaveBeenCalledWith("p1"));
		expect(screen.queryByLabelText("Engine")).toBeNull();
		expect(screen.getByRole("radio", { name: "urgent" })).toBeTruthy();
	});

	it("is prefilled from a share, and says so", async () => {
		mockApi.engines.mockResolvedValue([]);
		holdShareDraft(draftFromShare([{ shareType: "url", value: "https://example.com/issue/1" }]));
		mockParams.shared = "1";
		await render(<NewCard />);
		expect(screen.getByLabelText("Title").props.value).toBe("https://example.com/issue/1");
		expect(screen.getByLabelText("Description").props.value).toBe("https://example.com/issue/1");
		expect(screen.getByText(/Read it before creating the card/)).toBeTruthy();
		// Nothing is created until the person presses Create.
		expect(mockApi.createCard).not.toHaveBeenCalled();
	});

	it("keeps the description multiline, for the keyboard's dictation", async () => {
		mockApi.engines.mockResolvedValue([]);
		await render(<NewCard />);
		expect(screen.getByLabelText("Description").props.multiline).toBe(true);
	});
});
