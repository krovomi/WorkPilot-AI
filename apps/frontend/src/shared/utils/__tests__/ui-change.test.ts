/**
 * Whether a task's diff touches a web interface (#383), read from file names
 * only, across stacks.
 */
import { describe, expect, it } from "vitest";
import { touchesUserInterface } from "../ui-change";

describe("touchesUserInterface", () => {
	it.each([
		["a React component", "src/components/Cart.tsx"],
		["a Vue page", "pages/Index.VUE"],
		["a stylesheet", "styles/main.scss"],
		["a Razor view", "Views/Home/Index.cshtml"],
		["a Rails template", "app/views/cart/show.html.erb"],
		["a Laravel template", "resources/views/cart.blade.php"],
		["a Django template", "templates/cart.html"],
		["a Flutter widget", "lib/cart_screen.dart"],
	])("says yes for %s", (_label, path) => {
		expect(touchesUserInterface(["README.md", path])).toBe(true);
	});

	it("says no for back-end code, configuration or nothing", () => {
		expect(touchesUserInterface(["api/cart.py", "src/server.ts", "Cargo.toml", "app/models/cart.rb"])).toBe(false);
		expect(touchesUserInterface([])).toBe(false);
	});
});
