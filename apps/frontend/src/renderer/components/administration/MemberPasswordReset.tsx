/**
 * Members tab, platform administrator only: issue a password reset link for
 * an account whose owner lost the password.
 *
 * The server emails the link when it can; otherwise it hands it to the
 * administrator once, shown here to copy and send. Only a platform
 * administrator gets the button: an account can belong to several
 * organizations, and the server refuses anyone else.
 */
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import { formatAppDateTime } from "@/lib/date-format";
import type { PasswordResetIssued } from "../../../preload/api/modules/server-auth-api";

export type ResetNotice =
	| { kind: "issued"; issued: PasswordResetIssued }
	| { kind: "failed"; error: string };

export function MemberPasswordResetButton({
	userId,
	name,
	onResult,
}: {
	userId: string;
	name: string;
	onResult: (notice: ResetNotice) => void;
}) {
	const { t } = useTranslation("administration");
	const [busy, setBusy] = useState(false);
	return (
		<Button
			size="sm"
			variant="ghost"
			title={t("members.passwordReset.action")}
			aria-label={t("members.passwordReset.actionNamed", { name })}
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const result = await window.electronAPI.serverAuth.issuePasswordReset(userId);
					onResult(
						result.ok
							? { kind: "issued", issued: result.data }
							: { kind: "failed", error: result.error },
					);
				} finally {
					setBusy(false);
				}
			}}
		>
			<KeyRound className="h-4 w-4" />
		</Button>
	);
}

export function PasswordResetNotice({ notice }: { notice: ResetNotice }) {
	const { t } = useTranslation("administration");
	const [copied, setCopied] = useState(false);
	if (notice.kind === "failed") {
		return (
			<p className="wp-card p-3 text-sm text-destructive" role="alert">
				{t("members.passwordReset.failed")}: {notice.error}
			</p>
		);
	}
	const { issued } = notice;
	if (issued.email_sent || !issued.reset_link) {
		return (
			<p className="wp-card p-3 text-sm" role="status">
				{t("members.passwordReset.sent", { email: issued.email })}
			</p>
		);
	}
	const link = issued.reset_link;
	return (
		<div className="wp-card space-y-2 p-3 text-sm" role="status">
			<p>
				{t("members.passwordReset.copyLink", {
					email: issued.email,
					expires: formatAppDateTime(issued.expires_at),
				})}
			</p>
			<div className="flex items-center gap-2">
				<code className="flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{link}</code>
				<Button
					size="sm"
					variant="outline"
					onClick={async () => {
						await navigator.clipboard.writeText(link);
						setCopied(true);
					}}
				>
					<Copy className="mr-2 h-4 w-4" />
					{copied ? t("members.passwordReset.copied") : t("members.passwordReset.copy")}
				</Button>
			</div>
		</div>
	);
}
