import { Bot, Key, LogIn, Shield } from "lucide-react";
import { useState } from "react";
import { ProfileEditDialog } from "../settings/ProfileEditDialog";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { useTranslation } from "react-i18next";

interface AuthChoiceStepProps {
	readonly onNext: () => void;
	readonly onBack?: () => void;
	readonly onSkip: () => void;
	readonly onAPIKeyPathComplete?: () => void; // Called when profile is created (skips oauth)
	/** Any provider other than Claude: Codex, Copilot, Gemini, OpenCode, Ollama… */
	readonly onOtherProvider?: () => void;
}

interface AuthOptionCardProps {
	readonly icon: React.ReactNode;
	readonly title: string;
	readonly description: string;
	readonly onClick: () => void;
	readonly variant?: "default" | "oauth";
	readonly "data-testid"?: string;
}

function AuthOptionCard({
	icon,
	title,
	description,
	onClick,
	variant = "default",
	"data-testid": dataTestId,
}: AuthOptionCardProps) {
	return (
		<Card
			data-testid={dataTestId}
			className={`border border-border bg-card/50 backdrop-blur-sm cursor-pointer transition-all hover:border-primary/50 hover:shadow-md ${
				variant === "oauth" ? "hover:bg-accent/5" : ""
			}`}
			onClick={onClick}
		>
			<CardContent className="p-6">
				<div className="flex items-start gap-4">
					<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						{icon}
					</div>
					<div className="flex-1">
						<h3 className="font-semibold text-foreground text-lg">{title}</h3>
						<p className="mt-2 text-sm text-muted-foreground leading-relaxed">
							{description}
						</p>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * AuthChoiceStep component for the onboarding wizard.
 *
 * Allows new users to choose between:
 * 1. OAuth authentication (Sign in with Anthropic)
 * 2. Custom API key authentication (Use Custom API Key)
 * 3. Another AI provider (OpenAI Codex, GitHub Copilot, Gemini, OpenCode…)
 *
 * Features:
 * - Two equal-weight authentication options
 * - Skip button for users who want to configure later
 * - API key path opens ProfileEditDialog for profile creation
 * - OAuth path proceeds to OAuthStep
 *
 * AC Coverage:
 * - AC1: Displays first-run screen with two clear options
 */
export function AuthChoiceStep({
	onNext,
	onBack,
	onSkip,
	onAPIKeyPathComplete,
	onOtherProvider,
}: AuthChoiceStepProps) {
	const { t } = useTranslation();
	const [isProfileDialogOpen, setIsProfileDialogOpen] = useState(false);

	// OAuth button handler - proceeds to OAuth step
	const handleOAuthChoice = () => {
		onNext();
	};

	// API Key button handler - opens profile dialog
	const handleAPIKeyChoice = () => {
		setIsProfileDialogOpen(true);
	};

	return (
		<>
			<div className="flex h-full flex-col items-center justify-center px-8 py-6">
				<div className={`w-full ${onOtherProvider ? "max-w-4xl" : "max-w-2xl"}`}>
					{/* Hero Section */}
					<div className="text-center mb-8">
						<div className="flex justify-center mb-4">
							<div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
								<Shield className="h-8 w-8 text-primary" />
							</div>
						</div>
						<h1 className="text-3xl font-bold text-foreground tracking-tight">
							{t("onboarding:authChoice.title")}
						</h1>
						<p className="mt-3 text-muted-foreground text-lg">
							{t("onboarding:authChoice.description")}
						</p>
					</div>

					{/* Authentication Options - Equal Visual Weight */}
					<div
						className={`grid grid-cols-1 gap-6 mb-10 ${onOtherProvider ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}
					>
						<AuthOptionCard
							icon={<LogIn className="h-6 w-6" />}
							title={t("onboarding:authChoice.oauthTitle")}
							description={t("onboarding:authChoice.oauthDescription")}
							onClick={handleOAuthChoice}
							variant="oauth"
							data-testid="auth-option-oauth"
						/>
						<AuthOptionCard
							icon={<Key className="h-6 w-6" />}
							title={t("onboarding:authChoice.apiKeyTitle")}
							description={t("onboarding:authChoice.apiKeyDescription")}
							onClick={handleAPIKeyChoice}
							data-testid="auth-option-apikey"
						/>
						{onOtherProvider && (
							<AuthOptionCard
								icon={<Bot className="h-6 w-6" />}
								title={t("onboarding:authChoice.otherTitle")}
								description={t("onboarding:authChoice.otherDescription")}
								onClick={onOtherProvider}
								data-testid="auth-option-other"
							/>
						)}
					</div>

					{/* Info text */}
					<div className="text-center mb-8">
						<p className="text-muted-foreground text-sm">
							{t("onboarding:authChoice.footer")}
						</p>
					</div>

					{/* Action Buttons */}
					<div className="flex justify-center gap-4">
						{onBack && (
							<Button
								size="lg"
								variant="outline"
								onClick={onBack}
								className="text-muted-foreground hover:text-foreground"
							>
								{t("common:buttons.back")}
							</Button>
						)}
						<Button
							size="lg"
							variant="ghost"
							onClick={onSkip}
							className="text-muted-foreground hover:text-foreground"
						>
							{t("onboarding:authChoice.skip")}
						</Button>
					</div>
				</div>
			</div>

			{/* Profile Edit Dialog for API Key Path */}
			{/* No profile prop = create mode. `onSaved` fires only after a save:
			    the close handler used to compare a profile count captured before
			    the save, so a created profile never skipped the OAuth step. */}
			<ProfileEditDialog
				open={isProfileDialogOpen}
				onOpenChange={setIsProfileDialogOpen}
				onSaved={onAPIKeyPathComplete}
			/>
		</>
	);
}
