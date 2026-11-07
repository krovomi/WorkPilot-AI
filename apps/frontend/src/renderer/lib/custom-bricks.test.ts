import { describe, expect, it } from "vitest";
import { blockMeta } from "./architecture-blocks";
import {
	applyBricks,
	BRICK_ICONS,
	brickNodeData,
	type CustomBrick,
	DEFAULT_BRICK_ACCENT,
	normalizeBrick,
	resolveLook,
} from "./custom-bricks";

const hermes: CustomBrick = {
	id: "brick-1",
	name: "Hermes",
	kicker: "Agent principal",
	accent: "#f97316",
	icon: "bot",
	description: "Orchestre les sous-agents",
	stack: "Opus",
};

describe("normalizeBrick", () => {
	it("refuses a brick without a name", () => {
		expect(normalizeBrick({ name: "   " })).toBeNull();
	});

	it("trims, bounds and repairs what it keeps", () => {
		const brick = normalizeBrick({
			name: `  ${"x".repeat(200)} `,
			accent: "orange",
			icon: "not-an-icon",
		});
		expect(brick?.name).toHaveLength(60);
		expect(brick?.accent).toBe(DEFAULT_BRICK_ACCENT);
		expect(brick?.icon).toBe("blocks");
		expect(brick?.kicker).toBe("");
	});
});

describe("brickNodeData / applyBricks", () => {
	it("gives a new block the brick's name, look and stack", () => {
		expect(brickNodeData(hermes)).toMatchObject({
			label: "Hermes",
			type: "custom",
			brickId: "brick-1",
			kicker: "Agent principal",
			accent: "#f97316",
			icon: "bot",
			framework: "Opus",
		});
	});

	it("restyles the blocks made from an edited brick, keeping their own name", () => {
		const nodes = [{ id: "n1", data: { ...brickNodeData(hermes), label: "Hermes prod" } }];
		const edited = { ...hermes, accent: "#3b82f6", kicker: "Orchestrateur" };
		const [node] = applyBricks(nodes, [edited]);
		expect(node.data).toMatchObject({
			label: "Hermes prod",
			accent: "#3b82f6",
			kicker: "Orchestrateur",
		});
	});

	it("returns the same array when nothing changed, and keeps orphans as they are", () => {
		const nodes = [
			{ id: "n1", data: brickNodeData(hermes) },
			{ id: "n2", data: { label: "Gone", brickId: "deleted", accent: "#123456" } },
		];
		expect(applyBricks(nodes, [hermes])).toBe(nodes);
		expect(applyBricks(nodes, [])).toBe(nodes);
	});
});

describe("resolveLook", () => {
	it("draws a palette block with its type's colour, icon and role", () => {
		const look = resolveLook({ type: "database" });
		expect(look.accent).toBe(blockMeta("database")?.accent);
		expect(look.icon).toBe(blockMeta("database")?.icon);
		expect(look.kickerKey).toBe("database");
		expect(look.kicker).toBeUndefined();
	});

	it("lets the block's own colour, icon and role win", () => {
		const look = resolveLook({
			type: "database",
			accent: "#ff00ff",
			icon: "bot",
			kicker: "Source de vérité",
		});
		expect(look.accent).toBe("#ff00ff");
		expect(look.icon).toBe(BRICK_ICONS.bot);
		expect(look.kicker).toBe("Source de vérité");
	});

	it("ignores a colour that is not a hex colour", () => {
		expect(resolveLook({ type: "database", accent: "red;" }).accent).toBe(
			blockMeta("database")?.accent,
		);
	});
});
