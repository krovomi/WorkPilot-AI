/**
 * What `kanban-agile.e2e.ts` reads on the board and on the disk: a card by
 * its title (in a column, or anywhere), the files the app keeps for it
 * (`.workpilot/specs/<spec>/`), the project's sprints
 * (`.workpilot/sprints.json`), and a pointer drag that dnd-kit takes as one.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";

export class AgileBoard {
	constructor(
		readonly page: Page,
		readonly projectDir: string,
	) {}

	/** The card titled `title`, wherever the board shows it. */
	card(title: string): Locator {
		return this.page.locator(`[role="option"][aria-label="${title}"]`);
	}

	/** The card titled `title` in the board column `status`. */
	cardIn(status: string, title: string): Locator {
		return this.page.locator(
			`[data-column-status="${status}"] [role="option"][aria-label="${title}"]`,
		);
	}

	column(status: string): Locator {
		return this.page.locator(`[data-column-status="${status}"]`);
	}

	private specsRoot(): string {
		return path.join(this.projectDir, ".workpilot", "specs");
	}

	private readJson(file: string): Record<string, unknown> {
		try {
			return JSON.parse(readFileSync(file, "utf-8"));
		} catch {
			return {};
		}
	}

	/** Every spec folder of the project. */
	specDirs(): string[] {
		let names: string[] = [];
		try {
			names = readdirSync(this.specsRoot());
		} catch {
			return [];
		}
		return names
			.filter((name) => !name.startsWith("."))
			.map((name) => path.join(this.specsRoot(), name));
	}

	/** The spec folder of the card whose plan is titled `title`, if any. */
	findSpecDir(title: string): string | undefined {
		return this.specDirs().find(
			(dir) => this.readJson(path.join(dir, "implementation_plan.json")).feature === title,
		);
	}

	/** The spec folder of the card whose plan is titled `title`. */
	specDir(title: string): string {
		const found = this.findSpecDir(title);
		if (!found) throw new Error(`no spec for the card « ${title} »`);
		return found;
	}

	/** The card's plan title, as the app writes it on disk. */
	planTitle(dir: string): unknown {
		return this.readJson(path.join(dir, "implementation_plan.json")).feature;
	}

	/** The card's `task_metadata.json` (priority, sprint, abandon…). */
	metadata(dir: string): Record<string, unknown> {
		return this.readJson(path.join(dir, "task_metadata.json"));
	}

	plan(dir: string): Record<string, unknown> {
		return this.readJson(path.join(dir, "implementation_plan.json"));
	}

	writePlan(dir: string, plan: Record<string, unknown>): void {
		writeFileSync(path.join(dir, "implementation_plan.json"), JSON.stringify(plan, null, 2));
	}

	/** The project's sprints, as `.workpilot/sprints.json` keeps them. */
	sprints(): { id: string; name: string; state: string; report?: Record<string, number> }[] {
		const file = path.join(this.projectDir, ".workpilot", "sprints.json");
		const data = this.readJson(file) as { sprints?: unknown };
		return Array.isArray(data.sprints) ? data.sprints : [];
	}

	sprint(name: string) {
		return this.sprints().find((sprint) => sprint.name === name);
	}

	/**
	 * Drags `from` onto `to` with the mouse, in the small steps dnd-kit's
	 * pointer sensor needs to start a drag and to see the target under it.
	 * The card is held by its description line, below the title: a press on
	 * the title starts a rename, and the selection bar covers the board's foot.
	 */
	async drag(from: Locator, to: Locator): Promise<void> {
		await from.scrollIntoViewIfNeeded();
		const source = await from.boundingBox();
		const target = await to.boundingBox();
		if (!source || !target) throw new Error("drag: an element is not on screen");
		const startX = source.x + source.width / 2;
		const startY = source.y + 45;
		const endX = target.x + target.width / 2;
		// The middle of the target: the board finds the drop by the closest
		// corners, and a tall column's corners are far from its top.
		const endY = target.y + target.height / 2;
		await this.page.mouse.move(startX, startY);
		await this.page.mouse.down();
		await this.page.mouse.move(startX + 12, startY + 12, { steps: 4 });
		await this.page.mouse.move(endX, endY, { steps: 25 });
		await this.page.mouse.move(endX + 2, endY + 2, { steps: 2 });
		await this.page.mouse.up();
	}

	/**
	 * Widens the window so that every column of the board is on screen, as on
	 * a wide monitor: a drag onto a column out of view would scroll the board
	 * under the pointer and drop elsewhere.
	 */
	async showWholeBoard(app: ElectronApplication): Promise<void> {
		await app.evaluate(({ BrowserWindow }) => {
			const [window] = BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().startsWith("devtools:"));
			window.setSize(2900, 1000);
		});
		await expect.poll(() => this.page.evaluate(() => window.innerWidth)).toBeGreaterThan(2800);
	}

	/** Creates one card per title from the quick-add box of `addButton`. */
	async quickAdd(addButton: string, titles: string[]): Promise<void> {
		await this.page.getByRole("button", { name: addButton, exact: true }).first().click();
		const box = this.page.getByRole("textbox", { name: "Describe the new task" });
		for (const title of titles) {
			await box.fill(title);
			await box.press("Enter");
			await expect(this.card(title)).toBeVisible({ timeout: 15_000 });
			await expect(box).toHaveValue("");
		}
		await box.press("Escape");
		await expect(box).toBeHidden();
	}

	/** Opens the toolbar's « Sprints » menu. */
	async openSprintMenu(): Promise<Locator> {
		await this.page.getByTestId("kanban-sprint-menu").click();
		const menu = this.page.getByRole("dialog").filter({ hasText: "Backlog (no sprint)" });
		await expect(menu).toBeVisible();
		return menu;
	}
}
