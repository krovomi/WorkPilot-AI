/**
 * A generated-code card is named after the file it worked on, not its path.
 * The path with a space in a folder name used to slip through whole, then get
 * cut before the file name: "Tests générés : /home/me/perso/IA - LLM …".
 */
import { describe, expect, it } from "vitest";
import { looksLikePath, pathLeaf, reviewSubject } from "../review-subject";

describe("reviewSubject", () => {
	it("names an absolute path by its file, spaces in folders included", () => {
		expect(
			reviewSubject("/home/me/repositories/perso/IA - LLM/app/services/order_service.py"),
		).toBe("order_service.py");
		expect(reviewSubject("C:\\Repositories\\Perso\\My App\\src\\Cart.cs")).toBe("Cart.cs");
		expect(reviewSubject("\\\\server\\share\\My Project\\lib.ts")).toBe("lib.ts");
	});

	it("names a relative path by its file", () => {
		expect(reviewSubject("src/components/Button.tsx")).toBe("Button.tsx");
	});

	it("keeps a sentence a sentence, even with a slash in it", () => {
		expect(reviewSubject("log in/log out from the header")).toBe("log in/log out from the header");
	});

	it("cuts a long sentence to fit a one-line commit subject", () => {
		const subject = reviewSubject("As a customer I want to pay my order with a saved card");
		expect(subject).toHaveLength(40);
		expect(subject.endsWith("…")).toBe(true);
	});

	it("tells paths from text", () => {
		expect(looksLikePath("/srv/app")).toBe(true);
		expect(looksLikePath("D:/work/app")).toBe(true);
		expect(looksLikePath("first line\n/second")).toBe(false);
		expect(looksLikePath("")).toBe(false);
		expect(pathLeaf("/a/b/c/")).toBe("c");
	});
});
