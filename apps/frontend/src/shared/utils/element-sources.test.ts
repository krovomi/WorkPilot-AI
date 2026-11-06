/**
 * From a pointed element to the files that render it, whatever the stack.
 */

import { describe, expect, it } from "vitest";
import {
	type PointedNode,
	type SourceFile,
	composeContext,
	isTemplateFile,
	markersOf,
	pickStyles,
	rankCandidates,
	selectorOf,
	textOf,
} from "./element-sources";

function node(partial: Partial<PointedNode>): PointedNode {
	return {
		tag: "button",
		attributes: {},
		path: ["section.checkout", "main", "body", "html"],
		outerHtml: "<button>Pay now</button>",
		styles: {},
		url: "http://localhost:5173/cart",
		...partial,
	};
}

/** The same "Pay now" button, written in each stack, beside decoys. */
const STACKS: Record<string, SourceFile[]> = {
	react: [
		{
			path: "src/components/Checkout.tsx",
			text: 'export function Checkout() {\n  return (\n    <section className="checkout">\n      <button data-testid="pay-button" className="pay-cta px-4">\n        Pay now\n      </button>\n    </section>\n  );\n}\n',
		},
		{ path: "src/components/Header.tsx", text: '<header className="flex px-4">Shop</header>' },
	],
	angular: [
		{
			path: "src/app/checkout/checkout.component.html",
			text: '<section class="checkout">\n  <button data-testid="pay-button" class="pay-cta" (click)="pay()">Pay now</button>\n</section>\n',
		},
		{ path: "src/app/app.component.html", text: "<router-outlet></router-outlet>" },
	],
	vue: [
		{
			path: "src/components/CheckoutPanel.vue",
			text: '<template>\n  <section class="checkout">\n    <button data-testid="pay-button" class="pay-cta" @click="pay">Pay now</button>\n  </section>\n</template>\n<script setup lang="ts">\nconst pay = () => {};\n</script>\n',
		},
		{ path: "src/App.vue", text: "<template><RouterView /></template>" },
	],
	blazor: [
		{
			path: "Pages/Checkout.razor",
			text: '@page "/cart"\n<section class="checkout">\n    <button data-testid="pay-button" class="pay-cta" @onclick="Pay">Pay now</button>\n</section>\n@code {\n    void Pay() { }\n}\n',
		},
		{ path: "Shared/MainLayout.razor", text: "<main>@Body</main>" },
	],
	razorPages: [
		{
			path: "Pages/Cart.cshtml",
			text: '@page\n@model CartModel\n<section class="checkout">\n    <button id="pay" class="pay-cta" asp-page-handler="Pay">Pay now</button>\n</section>\n',
		},
		{ path: "Pages/Shared/_Layout.cshtml", text: "<body>@RenderBody()</body>" },
	],
};

describe("element sources", () => {
	it.each(Object.entries(STACKS))("finds the %s file that renders the element", (stack, files) => {
		const attributes: Record<string, string> =
			stack === "razorPages"
				? { id: "pay", class: "pay-cta" }
				: { "data-testid": "pay-button", class: "pay-cta px-4" };
		const found = rankCandidates(files, markersOf(node({ attributes })));
		expect(found[0]?.path).toBe(files[0].path);
		const expectedLine = files[0].text
			.split("\n")
			.findIndex((line) => line.includes(stack === "razorPages" ? '"pay"' : "pay-button"));
		expect(found[0]?.line).toBe(expectedLine + 1);
		expect(found.map((c) => c.path)).not.toContain(files[1].path);
	});

	it("matches visible text wrapped over several template lines", () => {
		const files = STACKS.react;
		const found = rankCandidates(files, markersOf(node({ outerHtml: "<button>Pay now</button>" })));
		expect(found[0]).toMatchObject({ path: "src/components/Checkout.tsx", markers: ["text"] });
	});

	it("never takes a utility or generated class as a marker", () => {
		const markers = markersOf(
			node({
				attributes: {
					class: "px-4 md:flex text-sm hover:bg-primary css-1x2y3z sc-bdVaJa Cart_root__3xYz2 btn checkout-summary",
				},
				outerHtml: "<div></div>",
			}),
		);
		expect(markers.filter((m) => m.kind === "class").map((m) => m.value)).toEqual([
			"checkout-summary",
		]);
	});

	it("drops a marker found in too many files: it locates nothing", () => {
		const files = Array.from({ length: 20 }, (_, i) => ({
			path: `src/c${i}.tsx`,
			text: '<span className="label">Total</span>',
		}));
		expect(rankCandidates(files, markersOf(node({ outerHtml: "<span>Total</span>" })))).toEqual(
			[],
		);
	});

	it("keeps only template files outside dependencies, builds and tests", () => {
		expect(isTemplateFile("src/App.tsx")).toBe(true);
		expect(isTemplateFile("Pages/Index.cshtml")).toBe(true);
		expect(isTemplateFile("resources/views/cart.blade.php")).toBe(true);
		expect(isTemplateFile("templates/cart.html.twig")).toBe(true);
		expect(isTemplateFile("app/views/cart/index.html.erb")).toBe(true);
		expect(isTemplateFile("lib/my_app_web/live/cart.html.heex")).toBe(true);
		expect(isTemplateFile("node_modules/react/index.js")).toBe(false);
		expect(isTemplateFile("dist/main.js")).toBe(false);
		expect(isTemplateFile("src/App.test.tsx")).toBe(false);
		expect(isTemplateFile("src/Button.stories.tsx")).toBe(false);
		expect(isTemplateFile("src/types.d.ts")).toBe(false);
		expect(isTemplateFile("README.md")).toBe(false);
	});

	it("reads the visible text, not the markup", () => {
		expect(textOf('<button class="a">Pay <b>now</b> &amp; save<script>x()</script></button>')).toBe(
			"Pay now & save",
		);
		expect(selectorOf("BUTTON", { id: "pay", class: "px-4 pay-cta" })).toBe("button#pay.pay-cta");
	});

	it("gives the agent the element, its path, its sources and its image", () => {
		const context = composeContext(
			node({
				attributes: { "data-testid": "pay-button" },
				styles: { color: "rgb(255, 0, 0)", "font-size": "14px", cursor: "pointer" },
			}),
			[{ path: "src/components/Checkout.tsx", line: 4, markers: ["testid"], score: 10 }],
			"pointed/abc.png",
		);
		expect(context).toContain("DOM path: html > body > main > section.checkout > button");
		expect(context).toContain("- src/components/Checkout.tsx:4 (testid)");
		expect(context).toContain("pointed/abc.png");
		expect(context).toContain("color: rgb(255, 0, 0); font-size: 14px");
		expect(context).not.toContain("cursor");
		const long = composeContext(node({ outerHtml: "x".repeat(20_000) }), [], null);
		expect(long.length).toBeLessThan(2000); // the HTML is cut, with a mark
		expect(long.endsWith("…")).toBe(true);
		expect(composeContext(node({}), [], null, 50)).toHaveLength(50);
	});

	it("puts the shorthands a remark uses back together", () => {
		const styles = pickStyles({
			"margin-top": "8px",
			"margin-right": "8px",
			"margin-bottom": "8px",
			"margin-left": "8px",
			"padding-top": "4px",
			"padding-right": "12px",
			"padding-bottom": "4px",
			"padding-left": "12px",
			"border-top-width": "1px",
			"border-top-style": "solid",
			"border-top-color": "rgb(0, 0, 0)",
			"row-gap": "normal",
			cursor: "pointer",
		});
		expect(styles).toEqual({
			margin: "8px",
			padding: "4px 12px 4px 12px",
			border: "1px solid rgb(0, 0, 0)",
		});
	});
});
