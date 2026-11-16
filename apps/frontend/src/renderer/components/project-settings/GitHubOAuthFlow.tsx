import {
	AlertCircle,
	Check,
	CheckCircle2,
	Clock,
	Copy,
	ExternalLink,
	Globe,
	Info,
	Loader2,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { useTranslation } from "react-i18next";

interface GitHubOAuthFlowProps {
	readonly onSuccess: (token: string, username?: string) => void;
	readonly onCancel?: () => void;
}

// Authentication timeout in milliseconds (5 minutes)
// GitHub device codes typically expire after 15 minutes, but 5 minutes is a reasonable UX timeout
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * GitHub OAuth flow component using gh CLI
 * Guides users through authenticating with GitHub using the gh CLI
 */
export function GitHubOAuthFlow({ onSuccess, onCancel }: GitHubOAuthFlowProps) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<
		| "checking"
		| "need-install"
		| "need-auth"
		| "authenticating"
		| "success"
		| "error"
	>("checking");
	const [error, setError] = useState<string | null>(null);
	const [cliVersion, setCliVersion] = useState<string | undefined>();
	const [username, setUsername] = useState<string | undefined>();

	// Device flow state for displaying code and auth URL
	const [deviceCode, setDeviceCode] = useState<string | null>(null);
	const [authUrl, setAuthUrl] = useState<string | null>(null);
	const [browserOpened, setBrowserOpened] = useState<boolean>(false);
	const [codeCopied, setCodeCopied] = useState<boolean>(false);
	const [urlCopied, setUrlCopied] = useState<boolean>(false);
	const [isTimeout, setIsTimeout] = useState<boolean>(false);
	// What Retry runs again: the step that failed, the CLI check or the sign-in.
	const [failedStep, setFailedStep] = useState<"check" | "auth">("check");

	// Ref to track authentication timeout
	const authTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Refs to track copy feedback timeouts
	const codeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const urlCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Check gh CLI installation and authentication status on mount
	// Use a ref to prevent double-execution in React Strict Mode
	const hasCheckedRef = useRef(false);

	// Clear the authentication timeout
	const clearAuthTimeout = useCallback(() => {
		if (authTimeoutRef.current) {
			clearTimeout(authTimeoutRef.current);
			authTimeoutRef.current = null;
		}
	}, []);

	// Cleanup the timeouts on unmount, and only then: a cleanup that ran on
	// every render cleared the authentication timeout as soon as it was set.
	useEffect(() => {
		return () => {
			clearAuthTimeout();
			if (codeCopyTimeoutRef.current) {
				clearTimeout(codeCopyTimeoutRef.current);
			}
			if (urlCopyTimeoutRef.current) {
				clearTimeout(urlCopyTimeoutRef.current);
			}
		};
	}, [clearAuthTimeout]);

	// Handle authentication timeout
	const handleAuthTimeout = useCallback(() => {
		setIsTimeout(true);
		setError(t("settings:githubOAuth.timedOutDescription"));
		setStatus("error");
		authTimeoutRef.current = null;
	}, [t]);

	/** The account name is passed along: the state set just before is not read yet. */
	const fetchAndNotifyToken = async (account?: string) => {
		try {
			const tokenResult = await globalThis.electronAPI.getGitHubToken();
			if (tokenResult.success && tokenResult.data?.token) {
				setStatus("success");
				onSuccess(tokenResult.data.token, account);
			} else {
				setError(tokenResult.error || t("settings:githubOAuth.tokenFailed"));
				setStatus("error");
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t("settings:githubOAuth.tokenFailed"),
			);
			setStatus("error");
		}
	};

	const checkGitHubStatus = async () => {
		setFailedStep("check");
		setStatus("checking");
		setError(null);

		try {
			const cliResult = await globalThis.electronAPI.checkGitHubCli();
			if (!cliResult.success) {
				setError(cliResult.error || t("settings:githubOAuth.cliCheckFailed"));
				setStatus("error");
				return;
			}

			if (!cliResult.data?.installed) {
				setStatus("need-install");
				return;
			}

			setCliVersion(cliResult.data.version);

			const authResult = await globalThis.electronAPI.checkGitHubAuth();
			if (authResult.success && authResult.data?.authenticated) {
				setUsername(authResult.data.username);
				await fetchAndNotifyToken(authResult.data.username);
			} else {
				setStatus("need-auth");
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t("settings:githubOAuth.cliCheckFailed"),
			);
			setStatus("error");
		}
	};

	const checkRef = useRef(checkGitHubStatus);
	checkRef.current = checkGitHubStatus;
	useEffect(() => {
		if (hasCheckedRef.current) return;
		hasCheckedRef.current = true;
		void checkRef.current();
	}, []);

	// Listen for device code events from the main process
	// This allows us to display the code IMMEDIATELY when extracted, not after the auth completes
	useEffect(() => {
		if (status !== "authenticating") {
			return;
		}

		const cleanup = globalThis.electronAPI.onGitHubAuthDeviceCode((data) => {
			if (data.deviceCode) {
				setDeviceCode(data.deviceCode);
			}
			if (data.authUrl) {
				setAuthUrl(data.authUrl);
			}
			setBrowserOpened(data.browserOpened);
		});

		return cleanup;
	}, [status]);

	const handleStartAuth = async () => {
		setFailedStep("auth");
		setStatus("authenticating");
		setError(null);

		// Reset device flow state
		setDeviceCode(null);
		setAuthUrl(null);
		setBrowserOpened(false);
		setCodeCopied(false);
		setUrlCopied(false);
		setIsTimeout(false);

		// Clear any existing timeout and start a new one
		clearAuthTimeout();
		authTimeoutRef.current = setTimeout(handleAuthTimeout, AUTH_TIMEOUT_MS);

		try {
			const result = await globalThis.electronAPI.startGitHubAuth();

			// Clear timeout since we got a response
			clearAuthTimeout();

			// Capture device flow info if available
			if (result.data?.deviceCode) {
				setDeviceCode(result.data.deviceCode);
			}
			if (result.data?.authUrl) {
				setAuthUrl(result.data.authUrl);
			}
			if (result.data?.browserOpened !== undefined) {
				setBrowserOpened(result.data.browserOpened);
			}

			if (result.success && result.data?.success) {
				await fetchAndNotifyToken(username);
			} else {
				setError(result.error || t("settings:githubOAuth.failed"));
				// Keep authUrl from response for fallback display
				if (result.data?.fallbackUrl) {
					setAuthUrl(result.data.fallbackUrl);
				}
				setStatus("error");
			}
		} catch (err) {
			clearAuthTimeout();
			setError(err instanceof Error ? err.message : t("settings:githubOAuth.failed"));
			setStatus("error");
		}
	};

	const handleOpenGhInstall = () => {
		window.open("https://cli.github.com/", "_blank");
	};

	const handleRetry = () => {
		void checkGitHubStatus();
	};

	const handleCopyDeviceCode = async (code: string) => {
		try {
			await navigator.clipboard.writeText(code);
			setCodeCopied(true);
			// Clear any existing timeout before setting a new one
			if (codeCopyTimeoutRef.current) {
				clearTimeout(codeCopyTimeoutRef.current);
			}
			// Reset the copied state after 2 seconds
			codeCopyTimeoutRef.current = setTimeout(() => setCodeCopied(false), 2000);
		} catch {
			// The code stays on screen to be typed.
		}
	};

	const handleOpenAuthUrl = (url: string) => {
		window.open(url, "_blank");
	};


	return (
		<div className="space-y-4">
			{/* Checking status */}
			{status === "checking" && (
				<div className="flex items-center justify-center py-8">
					<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}

			{/* Need to install gh CLI */}
			{status === "need-install" && (
				<div className="space-y-4">
					<Card className="border border-warning/30 bg-warning/10">
						<CardContent className="p-5">
							<div className="flex items-start gap-4">
								<Terminal className="h-6 w-6 text-warning shrink-0 mt-0.5" />
								<div className="flex-1 space-y-3">
									<h3 className="text-lg font-medium text-foreground">
										{t("settings:githubOAuth.cliRequired")}
									</h3>
									<p className="text-sm text-muted-foreground">
										{t("settings:githubOAuth.cliRequiredDescription")}
									</p>
									<div className="flex gap-3">
										<Button onClick={handleOpenGhInstall} className="gap-2">
											<ExternalLink className="h-4 w-4" />
											{t("settings:githubOAuth.installCli")}
										</Button>
										<Button variant="outline" onClick={handleRetry}>
											{t("settings:githubOAuth.installed")}
										</Button>
									</div>
								</div>
							</div>
						</CardContent>
					</Card>

					<Card className="border border-info/30 bg-info/10">
						<CardContent className="p-4">
							<div className="flex items-start gap-3">
								<Info className="h-5 w-5 text-info shrink-0 mt-0.5" />
								<div className="flex-1 text-sm text-muted-foreground">
									<p className="font-medium text-foreground mb-2">
										{t("settings:githubOAuth.installInstructions")}
									</p>
									<ul className="space-y-1 list-disc list-inside">
										<li>
											macOS:{" "}
											<code className="px-1.5 py-0.5 bg-muted rounded font-mono text-xs">
												brew install gh
											</code>
										</li>
										<li>
											Windows:{" "}
											<code className="px-1.5 py-0.5 bg-muted rounded font-mono text-xs">
												winget install GitHub.cli
											</code>
										</li>
										<li>
											{t("settings:githubOAuth.linuxVisit")}{" "}
											<a
												href="https://cli.github.com/"
												target="_blank"
												rel="noopener noreferrer"
												className="text-info hover:underline"
											>
												cli.github.com
											</a>
										</li>
									</ul>
								</div>
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			{/* Need authentication */}
			{status === "need-auth" && (
				<div className="space-y-4">
					<Card className="border border-info/30 bg-info/10">
						<CardContent className="p-5">
							<div className="flex items-start gap-4">
								<Globe className="h-6 w-6 text-info shrink-0 mt-0.5" />
								<div className="flex-1 space-y-3">
									<h3 className="text-lg font-medium text-foreground">
										{t("settings:githubOAuth.connectTitle")}
									</h3>
									<p className="text-sm text-muted-foreground">
										{t("settings:githubOAuth.connectDescription")}
									</p>
									{cliVersion && (
										<p className="text-xs text-muted-foreground">
											{t("settings:githubOAuth.usingCli", { version: cliVersion })}
										</p>
									)}
								</div>
							</div>
						</CardContent>
					</Card>

					<div className="flex justify-center">
						<Button onClick={handleStartAuth} size="lg" className="gap-2">
							<Globe className="h-5 w-5" />
							{t("settings:githubOAuth.authenticate")}
						</Button>
					</div>
				</div>
			)}

			{/* Authenticating */}
			{status === "authenticating" && (
				<div className="space-y-4">
					<Card className="border border-info/30 bg-info/10">
						<CardContent className="p-6">
							<div className="flex items-center gap-4">
								<Loader2 className="h-6 w-6 animate-spin text-info shrink-0" />
								<div className="flex-1">
									<h3 className="text-lg font-medium text-foreground">
										{t("settings:githubOAuth.authenticating")}
									</h3>
									<p className="text-sm text-muted-foreground mt-1">
										{browserOpened
											? t("settings:githubOAuth.completeInBrowser")
											: t("settings:githubOAuth.waitingStart")}
									</p>
								</div>
							</div>
						</CardContent>
					</Card>

					{/* Device Code Display */}
					{deviceCode && (
						<Card className="border border-primary/30 bg-primary/5">
							<CardContent className="p-6">
								<div className="text-center space-y-4">
									<div className="space-y-2">
										<p className="text-sm font-medium text-foreground">
											{t("settings:githubOAuth.oneTimeCode")}
										</p>
										<div className="flex items-center justify-center gap-3">
											<code className="text-3xl font-mono font-bold tracking-widest text-primary px-4 py-2 bg-primary/10 rounded-lg">
												{deviceCode}
											</code>
											<Button
												variant="outline"
												size="sm"
												onClick={() => void handleCopyDeviceCode(deviceCode)}
												className="shrink-0"
											>
												{codeCopied ? (
													<>
														<Check className="h-4 w-4 mr-1 text-success" />
														{t("settings:githubOAuth.copied")}
													</>
												) : (
													<>
														<Copy className="h-4 w-4 mr-1" />
														{t("settings:githubOAuth.copy")}
													</>
												)}
											</Button>
										</div>
									</div>

									<div className="text-sm text-muted-foreground space-y-2">
										<p>
											{browserOpened
												? t("settings:githubOAuth.enterCodeInBrowser")
												: t("settings:githubOAuth.copyThenOpen")}
										</p>
										{!browserOpened && authUrl && (
											<Button
												variant="link"
												onClick={() => handleOpenAuthUrl(authUrl)}
												className="text-info hover:text-info/80 p-0 h-auto gap-1"
											>
												<ExternalLink className="h-4 w-4" />
												{t("settings:githubOAuth.openLink", { url: authUrl })}
											</Button>
										)}
									</div>
								</div>
							</CardContent>
						</Card>
					)}
				</div>
			)}

			{/* Success */}
			{status === "success" && (
				<Card className="border border-success/30 bg-success/10">
					<CardContent className="p-6">
						<div className="flex items-start gap-4">
							<CheckCircle2 className="h-6 w-6 text-success shrink-0 mt-0.5" />
							<div className="flex-1">
								<h3 className="text-lg font-medium text-success">
									{t("settings:githubOAuth.connected")}
								</h3>
								<p className="text-sm text-success/80 mt-1">
									{username
										? t("settings:githubOAuth.connectedAs", { username })
										: t("settings:githubOAuth.accountConnected")}
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Error */}
			{status === "error" && error && (
				<div className="space-y-4">
					<Card
						className={`border ${isTimeout ? "border-warning/30 bg-warning/10" : "border-destructive/30 bg-destructive/10"}`}
					>
						<CardContent className="p-5">
							<div className="flex items-start gap-3">
								{isTimeout ? (
									<Clock className="h-5 w-5 text-warning shrink-0 mt-0.5" />
								) : (
									<AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
								)}
								<div className="flex-1">
									<h3
										className={`text-lg font-medium ${isTimeout ? "text-warning" : "text-destructive"}`}
									>
										{isTimeout
											? t("settings:githubOAuth.timedOut")
											: t("settings:githubOAuth.failed")}
									</h3>
									<p
										className={`text-sm mt-1 ${isTimeout ? "text-warning/80" : "text-destructive/80"}`}
									>
										{error}
									</p>
								</div>
							</div>
						</CardContent>
					</Card>

					{/* Fallback URL display when browser failed to open */}
					{authUrl && (
						<Card className="border border-warning/30 bg-warning/10">
							<CardContent className="p-5">
								<div className="space-y-4">
									<div className="flex items-start gap-3">
										<Info className="h-5 w-5 text-warning shrink-0 mt-0.5" />
										<div className="flex-1">
											<h3 className="text-base font-medium text-foreground">
												{t("settings:githubOAuth.manualTitle")}
											</h3>
											<p className="text-sm text-muted-foreground mt-1">
												{t("settings:githubOAuth.manualDescription")}
											</p>
										</div>
									</div>

									<div className="flex flex-col gap-3">
										<div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
											<code className="text-sm font-mono text-foreground flex-1 break-all">
												{authUrl}
											</code>
											<Button
												variant="outline"
												size="sm"
												onClick={async () => {
													try {
														await navigator.clipboard.writeText(authUrl);
														setUrlCopied(true);
														// Clear any existing timeout before setting a new one
														if (urlCopyTimeoutRef.current) {
															clearTimeout(urlCopyTimeoutRef.current);
														}
														urlCopyTimeoutRef.current = setTimeout(
															() => setUrlCopied(false),
															2000,
														);
													} catch {
														// The URL stays on screen to be copied by hand.
													}
												}}
												className="shrink-0"
											>
												{urlCopied ? (
													<>
														<Check className="h-4 w-4 mr-1 text-success" />
														{t("settings:githubOAuth.copied")}
													</>
												) : (
													<>
														<Copy className="h-4 w-4 mr-1" />
														{t("settings:githubOAuth.copy")}
													</>
												)}
											</Button>
										</div>

										<Button
											variant="secondary"
											onClick={() => handleOpenAuthUrl(authUrl)}
											className="gap-2"
										>
											<ExternalLink className="h-4 w-4" />
											{t("settings:githubOAuth.openUrl")}
										</Button>
									</div>

									{/* Device code reminder if available */}
									{deviceCode && (
										<div className="pt-2 border-t border-warning/20">
											<p className="text-sm text-muted-foreground">
												{t("settings:githubOAuth.enterCode")}{" "}
												<code className="font-mono font-bold text-primary px-2 py-0.5 bg-primary/10 rounded">
													{deviceCode}
												</code>
											</p>
										</div>
									)}
								</div>
							</CardContent>
						</Card>
					)}

					<div className="flex justify-center gap-3">
						<Button
							onClick={failedStep === "auth" ? handleStartAuth : handleRetry}
							variant="outline"
						>
							{t("common:buttons.retry")}
						</Button>
						{onCancel && (
							<Button onClick={onCancel} variant="ghost">
								{t("common:buttons.cancel")}
							</Button>
						)}
					</div>
				</div>
			)}

			{/* Cancel button for non-error states */}
			{status !== "error" && status !== "success" && onCancel && (
				<div className="flex justify-center pt-2">
					<Button onClick={onCancel} variant="ghost">
						{t("common:buttons.cancel")}
					</Button>
				</div>
			)}
		</div>
	);
}
