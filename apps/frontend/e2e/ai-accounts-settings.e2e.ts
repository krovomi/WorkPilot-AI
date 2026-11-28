/**
 * The AI accounts a person keeps, and what the tasks do with them, in the real
 * built app (tests plan since 1.5.0, lot E-C).
 *
 * Only the network and the model are left out. A connection test is answered
 * by a stand-in of the provider's model list in the main process (the same
 * `fetch` the app calls, so the key never leaves the machine), and a build is
 * `e2e/fake-backend/`: it writes down the account the app gave it
 * (`fake_accounts.py`), spends a fixed amount through the backend's own usage
 * tracker, and stops with OpenAI's 429 when the test says the account is out
 * of quota. Everything between them is the app: the accounts store, the pins
 * of a project and of a card, the failover to the next account, the month's
 * spend and its budget, the usage popover, and the switches every agent
 * process receives (code mode, the microVM sandbox), in English then French.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { isWindows } from "../src/main/platform";
import { type IsolatedApp, launchIsolatedApp, makeGitProject } from "./app-harness";
import { enterLocalMode, fakeBackendDir, openProject } from "./local-project";

test.describe.configure({ mode: "serial" });

/** Fake keys: the stand-in of OpenAI's model list accepts this prefix only. */
const KEY_PREFIX = "sk-test-e2e-";
const ACCOUNTS = {
	personal: { name: "Personal", key: `${KEY_PREFIX}personal-0000` },
	company: { name: "Company", key: `${KEY_PREFIX}company-0000` },
	old: { name: "Old laptop", key: `${KEY_PREFIX}old-0000` },
} as const;
type AccountName = keyof typeof ACCOUNTS;
/** The models the stand-in lists for an accepted key. */
const MODELS = ["gpt-e2e-mini", "gpt-e2e"];
/** What one fake coder session costs (`fake_accounts.SESSION_COST_USD`). */
const SESSION_COST_USD = 0.9;

let ctx: IsolatedApp;
let projectDir: string;
/** Account ids the store gave, by name. */
const ids: Partial<Record<AccountName, string>> = {};

interface StoredAccount {
	id: string;
	provider: string;
	name: string;
	keySetAt?: string;
}

interface Run {
	account: string | null;
	key: string | null;
	codeMode: string | null;
	microvm: boolean;
}

function profileFile(...parts: string[]): string {
	return path.join(ctx.root, "profile", ...parts);
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function accountsFile(): string {
	return profileFile("config", "ai-accounts.json");
}

function storedAccounts(): { accounts: StoredAccount[]; defaults: Record<string, string> } {
	if (!existsSync(accountsFile())) return { accounts: [], defaults: {} };
	const data = readJson<{ accounts?: StoredAccount[]; defaults?: Record<string, string> }>(
		accountsFile(),
	);
	return { accounts: data.accounts ?? [], defaults: data.defaults ?? {} };
}

function idOf(name: AccountName): string {
	const id = ids[name];
	if (!id) throw new Error(`account ${name} was not created`);
	return id;
}

/** The digest the fake build writes of the key it received. */
function keyDigest(name: AccountName): string {
	return createHash("sha256").update(ACCOUNTS[name].key, "utf8").digest("hex").slice(0, 16);
}

function specDirs(): string[] {
	const specs = path.join(projectDir, ".workpilot", "specs");
	if (!existsSync(specs)) return [];
	return readdirSync(specs)
		.filter((name) => !name.startsWith("."))
		.map((name) => path.join(specs, name));
}

/** The spec folder of the card whose description starts with `title`. */
function specDirOf(title: string): string {
	const found = specDirs().find((dir) => {
		const file = path.join(dir, "spec.md");
		const requirements = path.join(dir, "requirements.json");
		const text = [file, requirements]
			.filter((candidate) => existsSync(candidate))
			.map((candidate) => readFileSync(candidate, "utf-8"))
			.join("\n");
		return text.includes(title);
	});
	if (!found) throw new Error(`no spec folder for "${title}"`);
	return found;
}

function runsOf(specDir: string): Run[] {
	const file = path.join(specDir, "e2e-account-runs.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Run);
}

function cardIn(status: string, title: string): Locator {
	return ctx.page.locator(
		`[data-column-status="${status}"] [role="option"][aria-label="${title}"]`,
	);
}

/**
 * OpenAI's model list, answered in the main process: an accepted key lists
 * `MODELS`, any other key is refused as OpenAI refuses it. Every other request
 * goes out as before.
 */
async function answerModelListsOffline(): Promise<void> {
	await ctx.app.evaluate(
		(_electron, { prefix, models }) => {
			const real = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (!/^https:\/\/api\.openai\.com\/v1\/models\/?$/.test(url)) return real(input, init);
				const auth = new Headers(init?.headers).get("authorization") ?? "";
				const accepted = auth.startsWith(`Bearer ${prefix}`);
				const body = accepted
					? { object: "list", data: models.map((id: string) => ({ id, object: "model" })) }
					: { error: { message: "Incorrect API key provided", code: "invalid_api_key" } };
				return new Response(JSON.stringify(body), {
					status: accepted ? 200 : 401,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch;
		},
		{ prefix: KEY_PREFIX, models: MODELS },
	);
}

async function openSettings(page: Page, section: string | RegExp): Promise<void> {
	const dialogOpen = await page.getByRole("button", { name: "Save Settings" }).isVisible();
	if (!dialogOpen) await page.getByRole("button", { name: "Application Settings" }).click();
	await page.getByRole("button", { name: section, exact: typeof section === "string" }).first().click();
}

async function saveSettings(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Save Settings" }).click();
	await expect(page.getByRole("button", { name: "Save Settings" })).toBeHidden({
		timeout: 15_000,
	});
}

/**
 * Settings → AI accounts → OpenAI's accounts dialog, its API keys part (the
 * Codex CLI sign-ins follow it).
 */
async function openOpenAiAccounts(page: Page): Promise<Locator> {
	await openSettings(page, "AI accounts");
	const card = page.locator("[data-provider='openai']").first();
	await card.locator("[data-action='accounts']").click();
	const dialog = page.getByRole("dialog", { name: /^OpenAI.* accounts$/ });
	await expect(dialog).toBeVisible();
	return dialog.getByTestId("api-key-accounts");
}

function accountRow(dialog: Locator, name: AccountName): Locator {
	return dialog.getByTestId("ai-account").filter({ hasText: ACCOUNTS[name].name });
}

async function addAccount(dialog: Locator, name: AccountName): Promise<void> {
	await dialog.getByRole("button", { name: "Add an account" }).click();
	await dialog.getByLabel("Name").fill(ACCOUNTS[name].name);
	await dialog.getByLabel("API key").fill(ACCOUNTS[name].key);
	await dialog.getByRole("button", { name: "Add and test" }).click();
	const row = accountRow(dialog, name);
	// The test ran in the main process, against the stand-in of OpenAI.
	await expect(row.getByRole("status")).toHaveText(
		`The account answers (${MODELS.length} models available).`,
		{ timeout: 15_000 },
	);
	const stored = storedAccounts().accounts.find((a) => a.name === ACCOUNTS[name].name);
	expect(stored?.provider).toBe("openai");
	ids[name] = stored?.id;
}

test.beforeAll(async () => {
	ctx = await launchIsolatedApp({
		// OpenAI tasks: no Claude sign-in stands between a card and its build.
		settings: { autoBuildPath: fakeBackendDir(), selectedProvider: "openai" },
		gitIdentity: { name: "E2E User", email: "user@e2e.invalid" },
	});
	await answerModelListsOffline();
	projectDir = makeGitProject(ctx.root, "accounts-project");
	await enterLocalMode(ctx);
	await openProject(ctx, projectDir);
});

test.afterAll(async () => {
	await ctx?.close();
});

test("several OpenAI accounts: each tested on its own key, one of them the default", async () => {
	const { page } = ctx;
	const dialog = await openOpenAiAccounts(page);
	await expect(dialog.getByText("No account yet.")).toBeVisible();

	// The first key of a provider with no main key becomes its default.
	await addAccount(dialog, "personal");
	await expect(accountRow(dialog, "personal").getByText("Default", { exact: true })).toBeVisible();
	await addAccount(dialog, "company");
	await addAccount(dialog, "old");
	await expect(accountRow(dialog, "company").getByText("Default", { exact: true })).toHaveCount(0);
	expect(storedAccounts().defaults.openai).toBe(idOf("personal"));

	// A key typed is never shown or sent back to the page again.
	const html = await page.content();
	for (const account of Object.values(ACCOUNTS)) expect(html).not.toContain(account.key);
	await accountRow(dialog, "company").getByRole("button", { name: "Edit Company" }).click();
	await expect(dialog.getByLabel("API key")).toHaveValue("");
	await expect(dialog.getByLabel("API key")).toHaveAttribute(
		"placeholder",
		"Leave empty to keep the saved key",
	);
	await dialog.getByRole("button", { name: "Cancel" }).click();

	// The default moves from one account to another, on disk too.
	await accountRow(dialog, "company").getByRole("button", { name: "Use by default" }).click();
	await expect(accountRow(dialog, "company").getByText("Default", { exact: true })).toBeVisible();
	await expect.poll(() => storedAccounts().defaults.openai).toBe(idOf("company"));
	await accountRow(dialog, "personal").getByRole("button", { name: "Use by default" }).click();
	await expect.poll(() => storedAccounts().defaults.openai).toBe(idOf("personal"));

	// Deleting asks first; the key goes with the account.
	await accountRow(dialog, "old").getByRole("button", { name: "Delete Old laptop" }).click();
	await page.getByRole("alertdialog").getByRole("button", { name: /^(Delete|Confirm)$/ }).click();
	await expect(accountRow(dialog, "old")).toHaveCount(0);
	expect(storedAccounts().accounts.map((a) => a.name).sort()).toEqual(["Company", "Personal"]);
	const stored = readFileSync(accountsFile(), "utf-8");
	expect(stored).not.toContain(ACCOUNTS.old.key);
	// Encrypted when the OS has a keyring, and readable by this user alone either way.
	if (!isWindows()) expect(statSync(accountsFile()).mode & 0o777).toBe(0o600);

	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("code mode and the microVM sandbox start off, and their switches are saved", async () => {
	const { page } = ctx;
	await openSettings(page, "Code mode");
	await expect(page.getByTestId("code-mode-off")).toHaveAttribute("aria-pressed", "true");
	await page.getByTestId("code-mode-auto").click();
	await expect(page.getByTestId("code-mode-auto")).toHaveAttribute("aria-pressed", "true");

	await openSettings(page, "Sandbox");
	const microvm = page.locator("#sandbox-microvm");
	await expect(microvm).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("microvm-status")).toHaveCount(0);
	// On, the page looks for Docker Sandboxes on this machine and says what it found.
	await microvm.click();
	await expect(microvm).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("microvm-status")).not.toHaveText("Not checked yet.", {
		timeout: 15_000,
	});
	await saveSettings(page);
	const settings = () =>
		readJson<{
			codeMode?: string;
			agentSafety?: { sandbox?: { microvm?: { enabled?: boolean } } };
		}>(profileFile("settings.json"));
	await expect.poll(() => settings().codeMode).toBe("auto");
	expect(settings().agentSafety?.sandbox?.microvm?.enabled).toBe(true);

	// Back off: the tasks below run without a microVM, as a new install does.
	await openSettings(page, "Sandbox");
	await page.locator("#sandbox-microvm").click();
	await expect(page.locator("#sandbox-microvm")).toHaveAttribute("aria-checked", "false");
	await saveSettings(page);
	await expect.poll(() => settings().agentSafety?.sandbox?.microvm?.enabled).toBe(false);
});

const ON_PROJECT_ACCOUNT = "Write the changelog on the project's AI account.";
const ON_CARD_ACCOUNT = "Write the contributing guide on the card's AI account.";

/** Creates a card, its engine left as it is, and the card's OpenAI pin set to `pin`. */
async function createCard(title: string, pin?: AccountName): Promise<string> {
	const { page } = ctx;
	await page.getByRole("button", { name: /^New Task$/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByPlaceholder(/Describe the feature/).fill(title);
	const select = dialog.locator("#new-task-engine-account-openai");
	// A card follows its project's account until it picks one.
	await expect(select).toHaveText("Project's account (Company)");
	if (pin) {
		await select.click();
		await page.getByRole("option", { name: ACCOUNTS[pin].name, exact: true }).click();
		await expect(select).toHaveText(ACCOUNTS[pin].name);
	}
	await dialog.getByRole("button", { name: /^Create Task$/ }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	await expect(cardIn("backlog", title)).toBeVisible({ timeout: 15_000 });
	const specDir = specDirOf(title);
	// The build runs straight through once started.
	writeFileSync(path.join(specDir, "e2e-release"), "");
	return specDir;
}

function metadataOf(specDir: string): { provider?: string; aiAccounts?: Record<string, string> } {
	return readJson(path.join(specDir, "task_metadata.json"));
}

test("a project's AI account runs its cards, with that account's own key", async () => {
	const { page } = ctx;
	await openSettings(page, "General");
	const select = page.locator("#project-account-openai");
	await expect(select).toHaveText("Default account (Personal)");
	await select.click();
	await page.getByRole("option", { name: "Company", exact: true }).click();
	await expect(select).toHaveText("Company");
	await saveSettings(page);

	const specDir = await createCard(ON_PROJECT_ACCOUNT);
	expect(metadataOf(specDir).aiAccounts?.openai).toBeUndefined();
	await cardIn("backlog", ON_PROJECT_ACCOUNT).getByRole("button", { name: /^Start$/ }).click();
	await expect(cardIn("human_review", ON_PROJECT_ACCOUNT)).toBeVisible({ timeout: 60_000 });
	expect(runsOf(specDir)).toEqual([
		{ account: idOf("company"), key: keyDigest("company"), codeMode: "auto", microvm: false },
	]);
});

test("a card's own account wins, and a 429 moves it to the next account of OpenAI", async () => {
	const { page } = ctx;
	// Auto failover, on a limit, other accounts of the same provider first.
	await openSettings(page, "AI accounts");
	await page.getByRole("tab", { name: "Auto failover" }).click();
	for (const id of ["#failover-enabled", "#failover-rate-limit"]) {
		const toggle = page.locator(id);
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	}
	await expect(page.locator("#failover-same-provider")).toHaveAttribute("aria-checked", "true");
	for (const name of ["personal", "company"] as const) {
		await expect(page.locator(`[data-account="account-${idOf(name)}"]`)).toBeVisible();
	}
	await saveSettings(page);

	const specDir = await createCard(ON_CARD_ACCOUNT, "personal");
	expect(metadataOf(specDir).aiAccounts).toEqual({ openai: idOf("personal") });
	// Personal is out of quota: its run stops on OpenAI's 429.
	writeFileSync(path.join(specDir, "e2e-saturated-accounts"), `${idOf("personal")}\n`);
	await cardIn("backlog", ON_CARD_ACCOUNT).getByRole("button", { name: /^Start$/ }).click();

	await expect(cardIn("human_review", ON_CARD_ACCOUNT)).toBeVisible({ timeout: 90_000 });
	expect(runsOf(specDir).map((run) => [run.account, run.key])).toEqual([
		[idOf("personal"), keyDigest("personal")],
		[idOf("company"), keyDigest("company")],
	]);
	// The move pins Company on this card only: Personal stays OpenAI's default.
	expect(metadataOf(specDir).aiAccounts).toEqual({ openai: idOf("company") });
	expect(storedAccounts().defaults.openai).toBe(idOf("personal"));
});

test("each account's month adds up what its runs spent, against its budget", async () => {
	const { page } = ctx;
	const keys = await openOpenAiAccounts(page);
	const usd = (value: number) =>
		new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
	// Two runs on Company (one per card); Personal's run stopped before spending.
	const company = accountRow(keys, "company");
	await expect(company.getByTestId("account-spend")).toContainText(
		`This month: ${usd(2 * SESSION_COST_USD)} · 30K tokens`,
	);
	await expect(accountRow(keys, "personal").getByTestId("account-spend")).toContainText(
		`This month: ${usd(0)} · 0 tokens`,
	);

	await expect(company.getByText("No monthly budget")).toBeVisible();
	await company.getByRole("button", { name: "Set the monthly budget" }).click();
	await company.getByLabel("Monthly budget in US dollars").fill("2");
	await company.getByRole("button", { name: "Save", exact: true }).click();
	await expect(company.getByText(`90 % of ${usd(2)} a month`)).toBeVisible();
	await expect
		.poll(() => readFileSync(profileFile("config", "ai-account-budgets.json"), "utf-8"))
		.toContain(idOf("company"));
	// A typo is refused, not saved as no budget.
	await company.getByRole("button", { name: "Set the monthly budget" }).click();
	await company.getByLabel("Monthly budget in US dollars").fill("two");
	await company.getByRole("button", { name: "Save", exact: true }).click();
	await expect(company.getByRole("alert")).toHaveText(
		"Type an amount in dollars, or leave it empty for no budget.",
	);
	await company.getByRole("button", { name: "Cancel" }).click();
	await expect(company.getByText(`90 % of ${usd(2)} a month`)).toBeVisible();

	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Save Settings" })).toBeHidden();
});

test("the usage popover lists OpenAI's accounts with their spend, and switches the default", async () => {
	const { page } = ctx;
	await page.getByRole("button", { name: "Usage status" }).click();
	const switcher = page.getByTestId("provider-account-switcher");
	await expect(switcher).toBeVisible();
	const personal = switcher.getByRole("button", { name: /Personal/ });
	const company = switcher.getByRole("button", { name: /Company/ });
	await expect(personal).toHaveAttribute("aria-pressed", "true");
	await expect(company).toHaveAttribute("aria-pressed", "false");
	await expect(company).toContainText("$1.80");
	await company.click();
	await expect(company).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => storedAccounts().defaults.openai).toBe(idOf("company"));
	await page.keyboard.press("Escape");
});

const pad = (value: number) => String(value).padStart(2, "0");

/** `11/28/2026, 7:31:55 PM`: what `en` writes, whatever the system's region. */
function englishDateTime(date: Date): RegExp {
	const hours = date.getHours() % 12 || 12;
	const meridiem = date.getHours() < 12 ? "AM" : "PM";
	return new RegExp(
		`${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}, ` +
			`${hours}:${pad(date.getMinutes())}:${pad(date.getSeconds())}\\s${meridiem}`,
	);
}

/** `28/11/2026 19:31:55`: what `fr` writes. */
function frenchDateTime(date: Date): RegExp {
	return new RegExp(
		`${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
			`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
	);
}

test("in French the accounts' dates and amounts follow the app's language, then English again", async () => {
	const { page } = ctx;
	const keySetAt = storedAccounts().accounts.find((a) => a.id === idOf("personal"))?.keySetAt;
	expect(keySetAt).toBeTruthy();
	const keySet = new Date(keySetAt as string);

	let keys = await openOpenAiAccounts(page);
	await expect(accountRow(keys, "personal")).toContainText("Key saved on ");
	await expect(accountRow(keys, "personal")).toContainText(englishDateTime(keySet));
	await page.keyboard.press("Escape");

	await openSettings(page, "Language");
	await page.getByRole("button", { name: /Français/ }).click();
	await page.getByRole("button", { name: "Enregistrer les paramètres" }).click();
	await expect(page.getByRole("button", { name: "Enregistrer les paramètres" })).toBeHidden();
	await expect
		.poll(() => readJson<{ language?: string }>(profileFile("settings.json")).language)
		.toBe("fr");

	await page.getByRole("button", { name: "Paramètres de l'application" }).click();
	await page.getByRole("button", { name: "Comptes IA", exact: true }).first().click();
	await page.locator("[data-provider='openai'] [data-action='accounts']").first().click();
	keys = page.getByRole("dialog", { name: /^Comptes OpenAI/ }).getByTestId("api-key-accounts");
	const personal = accountRow(keys, "personal");
	await expect(personal).toContainText("Clé enregistrée le ");
	await expect(personal).toContainText(frenchDateTime(keySet));
	await expect(personal).not.toContainText(englishDateTime(keySet));
	const company = accountRow(keys, "company");
	await expect(company.getByTestId("account-spend")).toContainText(
		/Ce mois-ci : 1,80\s\$US · 30\sk tokens/,
	);
	await expect(company.getByTestId("account-spend")).toContainText(
		/90 % de 2,00\s\$US par mois/,
	);
	await page.keyboard.press("Escape");

	await page.getByRole("button", { name: "Langue", exact: true }).first().click();
	await page.getByRole("button", { name: /English/ }).click();
	await saveSettings(page);
	keys = await openOpenAiAccounts(page);
	await expect(accountRow(keys, "personal")).toContainText(englishDateTime(keySet));
	await expect(accountRow(keys, "company").getByTestId("account-spend")).toContainText(
		"This month: $1.80 · 30K tokens",
	);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
});
