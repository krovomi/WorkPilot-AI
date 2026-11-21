/**
 * Code links (#358, lot 3): imports of a module the other spec edits and uses
 * of a symbol the other removes, recognised the same way in any language.
 */
import { describe, expect, it } from "vitest";
import {
	buildSpecCode,
	codeLinks,
	distinctiveIdentifiers,
	importKeys,
	isDistinctive,
	MAX_REMOVED_SYMBOLS,
	moduleKey,
	removedSymbols,
} from "../code-links";
import { buildFootprint } from "../scorer";

describe("moduleKey", () => {
	it.each([
		["src/services/user_service.py", "user_service"],
		["src/cart/cartservice.java", "cartservice"],
		["web/components/user-card.tsx", "user-card"],
		["pkg/billing/index.ts", "billing"],
		["app/orders/__init__.py", "orders"],
		["src/core/utils.ts", "core/utils"],
		["lib/db.rb", "lib/db"],
		["include/foo.test.h", "foo"],
	])("%s is imported as %s", (file, key) => {
		expect(moduleKey(file)).toBe(key);
	});

	it.each([
		["utils.go", "a generic name at the root"],
		[".env", "a name with no stem"],
		["index.ts", "an index file at the root"],
		["x.c", "a one-letter stem at the root"],
		["-", "a stem of dashes only"],
		["", "an empty path"],
	])("%s gives no key (%s)", (file) => {
		expect(moduleKey(file)).toBeNull();
	});
});

describe("importKeys", () => {
	const keysOf = (text: string) => importKeys(text);

	it.each([
		["Python", "from app.services.user_service import load_user", "user_service"],
		["JavaScript", "import { x } from '../services/userService';", "userservice"],
		["CommonJS", "const db = require('./lib/db');", "lib/db"],
		["Java", "import com.acme.cart.CartService;", "cartservice"],
		["C", '#include "billing/invoice.h"', "invoice"],
		["Rust", "use crate::orders::checkout;", "checkout"],
		["C#", "using Acme.Payments;", "payments"],
		["CSS", '@import "styles/user-card.css";', "user-card"],
		["Ruby", "require_relative 'cart_store'", "cart_store"],
		["PHP", "require_once 'lib/mailer.php';", "mailer"],
		["shell", "source ./scripts/deploy_env.sh", "deploy_env"],
		["generic name with its folder", "import { x } from '../core/utils'", "core/utils"],
	])("reads a %s import", (_language, line, key) => {
		expect(keysOf(`// header\n${line}\nconst other = 1;\n`).has(key)).toBe(true);
	});

	it("reads Go's import block until it closes", () => {
		const keys = keysOf('package main\n\nimport (\n\t"fmt"\n\t"acme/billing"\n)\n\nvar shipping = 1\n');
		expect(keys.has("billing")).toBe(true);
		expect(keys.has("fmt")).toBe(true);
		expect(keys.has("shipping")).toBe(false);
	});

	it("ignores lines that import nothing", () => {
		const keys = keysOf("const userService = makeService();\n// we import nothing here\n");
		expect(keys.has("userservice")).toBe(false);
	});

	it("keeps words wrapped in dashes as words", () => {
		expect(keysOf("import x from '--weird--'").has("weird")).toBe(true);
	});
});

describe("distinctive identifiers", () => {
	it.each(["loadUser", "UserService", "load_user", "MAX_RETRIES", "parse2", "chargéÉtat"])(
		"%s is distinctive",
		(id) => {
			expect(isDistinctive(id)).toBe(true);
		},
	);

	it.each(["user", "Account", "render", "a_b", "_private", "x1"])("%s is not", (id) => {
		expect(isDistinctive(id)).toBe(false);
	});

	it("collects them from a text", () => {
		expect([...distinctiveIdentifiers("def load_user(id): return UserCache.get(id)")].sort()).toEqual([
			"UserCache",
			"load_user",
		]);
	});
});

describe("removedSymbols", () => {
	const diff = [
		"diff --git a/src/users.py b/src/users.py",
		"--- a/src/users.py",
		"+++ b/src/users.py",
		"@@ -1,2 +1,2 @@",
		"-def load_user(user_id):",
		"+def fetch_user(user_id):",
		"--- not a header: a removed SQL comment, inside the hunk",
		"-KEPT_NAME = keepAround",
		"+KEPT_NAME = 1",
		"diff --git a/b.py b/b.py",
		"--- a/b.py",
		"-header_only_name",
	].join("\n");

	it("gives what was removed and appears nowhere any more", () => {
		const after = [new Set(["fetch_user", "user_id", "KEPT_NAME"])];
		expect(removedSymbols(diff, after)).toEqual(["keepAround", "load_user"]);
	});

	it("drops what a file still holds", () => {
		expect(removedSymbols(diff, [new Set(["keepAround"])])).toEqual(["load_user"]);
	});

	it("keeps at most the limit", () => {
		const many = ["@@ -1 +1 @@", ...Array.from({ length: MAX_REMOVED_SYMBOLS + 5 }, (_, i) => `-name_${i}`)];
		expect(removedSymbols(many.join("\n"), [])).toHaveLength(MAX_REMOVED_SYMBOLS);
	});
});

describe("codeLinks", () => {
	const auth = buildFootprint(["src/auth/session_store.py", "src/shared.py"]);
	const billing = buildFootprint(["src/billing/invoice.py", "src/shared.py"]);

	const authCode = buildSpecCode(
		[
			{ path: "src/auth/session_store.py", text: "def open_session():\n    pass\n" },
			{ path: "src/shared.py", text: "from billing import invoice\n" },
		],
		"@@ -1 +1 @@\n-def make_invoice_token():\n+def open_session():\n",
	);
	const billingCode = buildSpecCode(
		[
			{
				path: "src/billing/invoice.py",
				text: "from auth.session_store import open_session\n\ntoken = make_invoice_token()\n",
			},
			{ path: "src/shared.py", text: "make_invoice_token()\n" },
		],
		null,
	);

	it("finds the import of a module the other edits and the use of a symbol it removes", () => {
		expect(codeLinks(auth, authCode, billing, billingCode)).toEqual({
			imports: ["src/billing/invoice.py → src/auth/session_store.py"],
			symbols: ["src/billing/invoice.py → make_invoice_token"],
		});
	});

	it("is the same both ways round", () => {
		expect(codeLinks(billing, billingCode, auth, authCode)).toEqual(
			codeLinks(auth, authCode, billing, billingCode),
		);
	});

	it("leaves shared files to the shared-file score", () => {
		const links = codeLinks(auth, authCode, billing, billingCode);
		expect([...links.imports, ...links.symbols].some((l) => l.startsWith("src/shared.py"))).toBe(false);
	});

	it("says nothing when either side was not read", () => {
		expect(codeLinks(auth, authCode, billing, null)).toEqual({ imports: [], symbols: [] });
		expect(codeLinks(auth, undefined, billing, billingCode)).toEqual({ imports: [], symbols: [] });
	});

	it("needs a key: a file named only by a generic name at the root links nothing", () => {
		const root = buildFootprint(["utils.py"]);
		const importer = buildFootprint(["app/main_view.py"]);
		const importerCode = buildSpecCode([{ path: "app/main_view.py", text: "import utils\n" }], null);
		const rootCode = buildSpecCode([], null);
		expect(codeLinks(root, rootCode, importer, importerCode).imports).toEqual([]);
	});

	it("indexes a key named by several files", () => {
		const code = buildSpecCode(
			[
				{ path: "a.py", text: "import session_store\n" },
				{ path: "b.py", text: "import session_store\n" },
			],
			null,
		);
		expect(code.imports.get("session_store")).toEqual(["a.py", "b.py"]);
	});
});
