import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	type BrickInput,
	type CustomBrick,
	normalizeBrick,
} from "../lib/custom-bricks";

/**
 * The person's own canvas bricks (see `lib/custom-bricks.ts`).
 *
 * A library, not part of an architecture: a brick made while drawing one
 * diagram is in the palette of every other. Kept apart from the architectures'
 * store because it is a handful of small records that every canvas reads, and
 * the architectures' store re-renders on every streamed file of a generation.
 */
interface CustomBricksState {
	bricks: CustomBrick[];
	/** Adds a brick and answers its id, or `null` when it has no name. */
	addBrick: (input: Partial<BrickInput>) => string | null;
	/** Answers whether the brick was saved (it needs a name). */
	updateBrick: (id: string, input: Partial<BrickInput>) => boolean;
	removeBrick: (id: string) => void;
}

function newBrickId(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return `brick-${uuid}`;
	return `brick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useCustomBricksStore = create<CustomBricksState>()(
	persist(
		(set, get) => ({
			bricks: [],
			addBrick: (input) => {
				const brick = normalizeBrick(input);
				if (!brick) return null;
				const id = newBrickId();
				set({ bricks: [...get().bricks, { id, ...brick }] });
				return id;
			},
			updateBrick: (id, input) => {
				const current = get().bricks.find((b) => b.id === id);
				if (!current) return false;
				const brick = normalizeBrick({ ...current, ...input });
				if (!brick) return false;
				set({
					bricks: get().bricks.map((b) => (b.id === id ? { id, ...brick } : b)),
				});
				return true;
			},
			removeBrick: (id) =>
				set({ bricks: get().bricks.filter((b) => b.id !== id) }),
		}),
		{
			name: "visual-to-code-bricks",
			version: 1,
			// What comes back from storage may have been edited by hand or written
			// by a later version: each brick goes through the same normalisation
			// as one typed in the editor, and one that fails it is dropped.
			merge: (persisted, current) => {
				const raw = (persisted as { bricks?: unknown } | undefined)?.bricks;
				const bricks = Array.isArray(raw)
					? raw.flatMap((b) => {
							const id = (b as { id?: unknown })?.id;
							const brick = normalizeBrick(b as Partial<BrickInput>);
							return typeof id === "string" && brick ? [{ id, ...brick }] : [];
						})
					: [];
				return { ...current, bricks };
			},
		},
	),
);
