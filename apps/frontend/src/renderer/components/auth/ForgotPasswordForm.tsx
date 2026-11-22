/**
 * "Forgot password?" on the server sign-in screen.
 *
 * Two steps: ask for a link by email (the server answers the same for any
 * address), then paste the link, see which account it is for and choose the
 * new password. A server without email says so: a platform administrator
 * then issues the link (Administration, Members). The main process checks
 * every argument and talks to the server; no token stays in the renderer.
 */
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
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

const MIN_PASSWORD_LENGTH = 12;

export function ForgotPasswordForm({
	serverUrl,
	onBack,
	onDone,
}: {
	serverUrl: string;
	onBack: () => void;
	/** The password is set: back to sign-in, which says so. */
	onDone: () => void;
}) {
	const { t } = useTranslation();
	const [step, setStep] = useState<"ask" | "set">("ask");
	const [url, setUrl] = useState(serverUrl);
	const [email, setEmail] = useState("");
	const [byEmail, setByEmail] = useState<boolean | null>(null);
	const [asked, setAsked] = useState(false);
	const [link, setLink] = useState("");
	const [account, setAccount] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// Whether this server can email a link at all.
	useEffect(() => {
		const target = url.trim();
		if (!target) return;
		let current = true;
		const handle = setTimeout(async () => {
			let enabled: boolean | null = null;
			try {
				const config = await window.electronAPI.serverAuth.getConfig(target);
				if (config.ok) enabled = config.data.password_reset_by_email === true;
			} catch {
				// unreachable: say nothing yet
			}
			if (current) setByEmail(enabled);
		}, 500);
		return () => {
			current = false;
			clearTimeout(handle);
		};
	}, [url]);

	// Which account the pasted link is for.
	useEffect(() => {
		setAccount(null);
		const target = url.trim();
		if (step !== "set" || !target || link.trim().length < 16) return;
		let current = true;
		const handle = setTimeout(async () => {
			const result = await window.electronAPI.serverAuth
				.lookupPasswordReset(target, link.trim())
				.catch(() => ({ ok: false as const, error: "" }));
			if (!current) return;
			if (result.ok) {
				setAccount(result.data.email);
				setError(null);
			} else {
				setError(t("passwordReset.invalidLink"));
			}
		}, 500);
		return () => {
			current = false;
			clearTimeout(handle);
		};
	}, [url, link, step, t]);

	const ask = async () => {
		setError(null);
		setBusy(true);
		try {
			const result = await window.electronAPI.serverAuth.requestPasswordReset(
				url.trim(),
				email.trim(),
			);
			if (result.ok) setAsked(true);
			else setError(result.error || t("passwordReset.failed"));
		} finally {
			setBusy(false);
		}
	};

	const save = async () => {
		setError(null);
		setBusy(true);
		try {
			const result = await window.electronAPI.serverAuth.confirmPasswordReset(
				url.trim(),
				link.trim(),
				password,
			);
			if (result.ok) onDone();
			else setError(result.error || t("passwordReset.failed"));
		} finally {
			setBusy(false);
		}
	};

	const canAsk = !!url.trim() && email.includes("@") && !busy && byEmail !== false;
	const canSave =
		!!account && password.length >= MIN_PASSWORD_LENGTH && password === confirm && !busy;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<KeyRound className="h-5 w-5" />
						{t("passwordReset.title")}
					</CardTitle>
					<CardDescription>
						{step === "ask"
							? t("passwordReset.askDescription")
							: t("passwordReset.setDescription")}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="reset-server-url">{t("serverLogin.serverUrl")}</Label>
						<Input
							id="reset-server-url"
							placeholder="https://workpilot.example.com"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
						/>
					</div>

					{step === "ask" ? (
						<>
							{byEmail === false ? (
								<p className="text-sm text-muted-foreground" role="note">
									{t("passwordReset.noEmail")}
								</p>
							) : (
								<div className="space-y-2">
									<Label htmlFor="reset-email">{t("serverLogin.email")}</Label>
									<Input
										id="reset-email"
										type="email"
										value={email}
										onChange={(e) => {
											setEmail(e.target.value);
											setAsked(false);
										}}
									/>
								</div>
							)}
							{asked && (
								<p className="text-sm text-muted-foreground" role="status">
									{t("passwordReset.sent")}
								</p>
							)}
						</>
					) : (
						<>
							<div className="space-y-2">
								<Label htmlFor="reset-link">{t("passwordReset.link")}</Label>
								<Input
									id="reset-link"
									value={link}
									onChange={(e) => setLink(e.target.value)}
								/>
								{account && (
									<p className="text-sm text-muted-foreground" role="status">
										{t("passwordReset.forAccount", { email: account })}
									</p>
								)}
							</div>
							<div className="space-y-2">
								<Label htmlFor="reset-password">{t("passwordReset.newPassword")}</Label>
								<Input
									id="reset-password"
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
								/>
								<p className="text-xs text-muted-foreground">
									{t("acceptInvite.passwordHint")}
								</p>
								<Label htmlFor="reset-confirm">{t("acceptInvite.confirm")}</Label>
								<Input
									id="reset-confirm"
									type="password"
									value={confirm}
									onChange={(e) => setConfirm(e.target.value)}
								/>
								{confirm && password !== confirm && (
									<p className="text-xs text-destructive">{t("acceptInvite.mismatch")}</p>
								)}
							</div>
						</>
					)}

					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}

					<div className="flex gap-2">
						<Button variant="outline" className="flex-1" onClick={onBack} disabled={busy}>
							<ArrowLeft className="mr-2 h-4 w-4" />
							{t("acceptInvite.back")}
						</Button>
						{step === "ask" ? (
							<Button
								className="flex-1"
								disabled={!canAsk}
								onClick={() => void ask()}
							>
								{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
								{t("passwordReset.send")}
							</Button>
						) : (
							<Button
								className="flex-1"
								disabled={!canSave}
								onClick={() => void save()}
							>
								{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
								{t("passwordReset.save")}
							</Button>
						)}
					</div>

					<button
						type="button"
						className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
						disabled={busy}
						onClick={() => {
							setError(null);
							setStep(step === "ask" ? "set" : "ask");
						}}
					>
						{step === "ask" ? t("passwordReset.haveLink") : t("passwordReset.needLink")}
					</button>
				</CardContent>
			</Card>
		</div>
	);
}
