/**
 * Full-screen connection gate for multi-user server mode.
 *
 * Lets the user pick between local mode (historical single-user behavior)
 * and a shared WorkPilot server, then sign in with a local account or
 * Microsoft Entra ID (system browser + PKCE, handled by the main process).
 */
import { Loader2, Monitor, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@/components/ui";
import { useServerSessionStore } from "../../stores/server-session-store";
import { AcceptInviteForm } from "./AcceptInviteForm";

const LAST_SERVER_URL_KEY = "workpilot-last-server-url";

export function ServerLoginScreen() {
	const { t } = useTranslation();
	const serverUrl = useServerSessionStore((s) => s.serverUrl);
	const loginLocal = useServerSessionStore((s) => s.loginLocal);
	const loginEntra = useServerSessionStore((s) => s.loginEntra);
	const switchToLocalMode = useServerSessionStore((s) => s.switchToLocalMode);

	const [view, setView] = useState<"login" | "invite">("login");

	const [url, setUrl] = useState(
		serverUrl || localStorage.getItem(LAST_SERVER_URL_KEY) || "",
	);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<"local" | "entra" | null>(null);
	const [entraEnabled, setEntraEnabled] = useState<boolean | null>(null);

	// Probe the server's auth config whenever the URL settles, so the UI
	// only offers the methods the server actually supports.
	// An answer for a URL the user has since changed is dropped, and a server
	// that cannot be reached offers the local account only.
	useEffect(() => {
		const target = url.trim();
		if (!target) return;
		let current = true;
		const handle = setTimeout(async () => {
			let enabled: boolean | null = null;
			try {
				const config = await window.electronAPI.serverAuth.getConfig(target);
				if (config.ok) enabled = config.data.entra_enabled;
			} catch {
				// unreachable server: same as an unknown configuration
			}
			if (current) setEntraEnabled(enabled);
		}, 500);
		return () => {
			current = false;
			clearTimeout(handle);
		};
	}, [url]);

	// A refused or failed sign-in says why, in the app's language when the server gave no reason.
	const signIn = useCallback(
		async (method: "local" | "entra", run: () => Promise<{ ok: boolean; error?: string }>) => {
			setError(null);
			setBusy(method);
			try {
				const result = await run();
				if (!result.ok) setError(result.error || t("serverLogin.failed"));
			} catch (err) {
				setError(err instanceof Error ? err.message : t("serverLogin.failed"));
			} finally {
				setBusy(null);
			}
		},
		[t],
	);

	const rememberUrl = useCallback((value: string) => {
		localStorage.setItem(LAST_SERVER_URL_KEY, value);
	}, []);

	const handleLocalLogin = useCallback(
		() =>
			signIn("local", () => {
				const trimmed = url.trim();
				rememberUrl(trimmed);
				return loginLocal(trimmed, email.trim(), password);
			}),
		[signIn, url, email, password, loginLocal, rememberUrl],
	);

	const handleEntraLogin = useCallback(
		() =>
			signIn("entra", () => {
				const trimmed = url.trim();
				rememberUrl(trimmed);
				return loginEntra(trimmed);
			}),
		[signIn, url, loginEntra, rememberUrl],
	);

	// Enter in the password field follows the same rule as the button.
	const canLogin = !!url.trim() && !!email.trim() && !!password && busy === null;

	if (view === "invite") {
		return <AcceptInviteForm onBack={() => setView("login")} />;
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Server className="h-5 w-5" />
						{t("serverLogin.title")}
					</CardTitle>
					<CardDescription>
						{t("serverLogin.description")}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="server-url">
							{t("serverLogin.serverUrl")}
						</Label>
						<Input
							id="server-url"
							placeholder="https://workpilot.example.com"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							autoFocus
						/>
					</div>

					{entraEnabled && (
						<Button
							className="w-full"
							variant="default"
							disabled={!url.trim() || busy !== null}
							onClick={handleEntraLogin}
						>
							{busy === "entra" ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : null}
							{t("serverLogin.entraButton")}
						</Button>
					)}

					<div className="space-y-2">
						<Label htmlFor="login-email">
							{t("serverLogin.email")}
						</Label>
						<Input
							id="login-email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
						<Label htmlFor="login-password">
							{t("serverLogin.password")}
						</Label>
						<Input
							id="login-password"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && canLogin) void handleLocalLogin();
							}}
						/>
					</div>

					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}

					<div className="flex gap-2">
						<Button
							className="flex-1"
							variant="secondary"
							disabled={!canLogin}
							onClick={handleLocalLogin}
						>
							{busy === "local" ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : null}
							{t("serverLogin.localAccountButton")}
						</Button>
						<Button
							className="flex-1"
							variant="outline"
							disabled={busy !== null}
							onClick={() => void switchToLocalMode()}
						>
							<Monitor className="mr-2 h-4 w-4" />
							{t("serverLogin.localModeButton")}
						</Button>
					</div>

					<button
						type="button"
						className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
						disabled={busy !== null}
						onClick={() => {
							setError(null);
							setView("invite");
						}}
					>
						{t("serverLogin.haveInvite")}
					</button>
				</CardContent>
			</Card>
		</div>
	);
}
