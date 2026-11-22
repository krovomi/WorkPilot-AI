/**
 * Joining a team server from local mode.
 *
 * The first-launch gate offers the choice once. Before this page, "Mode
 * local" there was final: the gate never reopened for a configured local
 * install, and the session page only showed once signed in to a server, so a
 * person who picked local mode by mistake had no way to sign in afterwards.
 * This page reopens the same sign-in screen (password, invitation, Microsoft,
 * SSO); "Mode local" on it goes back to local mode.
 */

import { LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import { useServerSessionStore } from "@/stores/server-session-store";
import { SettingsSection } from "./SettingsSection";

interface ServerConnectSettingsProps {
	/** Closes Settings, so the sign-in screen is not hidden behind it. */
	readonly onConnect: () => void;
}

export function ServerConnectSettings({ onConnect }: ServerConnectSettingsProps) {
	const { t } = useTranslation("settings");
	const openLoginScreen = useServerSessionStore((s) => s.openLoginScreen);
	return (
		<SettingsSection
			title={t("serverSession.connect.title")}
			description={t("serverSession.connect.description")}
		>
			<Button
				onClick={() => {
					onConnect();
					openLoginScreen();
				}}
			>
				<LogIn className="mr-2 h-4 w-4" />
				{t("serverSession.connect.button")}
			</Button>
		</SettingsSection>
	);
}
