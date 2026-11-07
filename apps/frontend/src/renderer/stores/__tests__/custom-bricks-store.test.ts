/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useCustomBricksStore } from "../custom-bricks-store";

describe("custom-bricks-store", () => {
	beforeEach(() => {
		useCustomBricksStore.setState({ bricks: [] });
	});

	it("adds a brick and answers its id", () => {
		const id = useCustomBricksStore
			.getState()
			.addBrick({ name: "Hermes", kicker: "Agent principal", accent: "#f97316" });
		expect(id).toMatch(/^brick-/);
		expect(useCustomBricksStore.getState().bricks).toMatchObject([
			{ id, name: "Hermes", kicker: "Agent principal", icon: "blocks" },
		]);
	});

	it("refuses a brick without a name, on creation and on edit", () => {
		const { addBrick, updateBrick } = useCustomBricksStore.getState();
		expect(addBrick({ name: " " })).toBeNull();
		const id = addBrick({ name: "Hermes" }) as string;
		expect(updateBrick(id, { name: "" })).toBe(false);
		expect(useCustomBricksStore.getState().bricks[0].name).toBe("Hermes");
	});

	it("edits and removes a brick", () => {
		const { addBrick, updateBrick, removeBrick } = useCustomBricksStore.getState();
		const id = addBrick({ name: "Hermes" }) as string;
		expect(updateBrick(id, { accent: "#3b82f6", icon: "bot" })).toBe(true);
		expect(useCustomBricksStore.getState().bricks[0]).toMatchObject({
			accent: "#3b82f6",
			icon: "bot",
		});
		removeBrick(id);
		expect(useCustomBricksStore.getState().bricks).toEqual([]);
	});

	it("drops stored bricks that are not bricks on rehydration", async () => {
		localStorage.setItem(
			"visual-to-code-bricks",
			JSON.stringify({
				state: {
					bricks: [
						{ id: "brick-a", name: "Ok", accent: "#000000", icon: "bot" },
						{ id: "brick-b", name: "" },
						{ name: "no id" },
						"junk",
					],
				},
				version: 1,
			}),
		);
		await useCustomBricksStore.persist.rehydrate();
		expect(useCustomBricksStore.getState().bricks.map((b) => b.id)).toEqual([
			"brick-a",
		]);
	});
});
