/**
 * The Auth tab of an API Explorer request: where its credentials come from
 * (the environment, none, a bearer token, Basic, an API key, OAuth 2.0), and
 * getting an OAuth 2.0 token. Split out of RequestPanel.tsx.
 */
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type ApiEnvironment,
	type AuthType,
	type OAuth2GrantType,
	useApiExplorerStore,
} from "../../stores/api-explorer-store";
import { Input } from "../ui/input";
import { requestOAuth2Token } from "./request-auth";
import { CustomSelect } from "./request-controls";

export interface RequestAuthTabProps {
	readonly activeEnv: ApiEnvironment | undefined;
	readonly onOpenEnvManager: () => void;
}

export function RequestAuthTab({
	activeEnv,
	onOpenEnvManager,
}: RequestAuthTabProps) {
	const { t } = useTranslation(["apiExplorer"]);
	const requestAuth = useApiExplorerStore((s) => s.requestAuth);
	const setRequestAuth = useApiExplorerStore((s) => s.setRequestAuth);
	const idBase = useId();
	const [showAuthToken, setShowAuthToken] = useState(false);
	const [showAuthPassword, setShowAuthPassword] = useState(false);
	const [showOAuth2Secret, setShowOAuth2Secret] = useState(false);
	const [showOAuth2Token, setShowOAuth2Token] = useState(false);
	const [isGettingOAuth2Token, setIsGettingOAuth2Token] = useState(false);
	const [oauth2TokenError, setOAuth2TokenError] = useState<string | null>(null);

	async function handleGetOAuth2Token() {
		setOAuth2TokenError(null);
		if (requestAuth.oauth2GrantType === "authorization_code") {
			// The person signs in in the browser and pastes the token back.
			if (requestAuth.oauth2AuthUrl) {
				window.open(requestAuth.oauth2AuthUrl, "_blank");
			}
			return;
		}
		if (!requestAuth.oauth2TokenUrl) {
			setOAuth2TokenError(t("apiExplorer:auth.oauth2.missingTokenUrl"));
			return;
		}
		setIsGettingOAuth2Token(true);
		try {
			const answer = await requestOAuth2Token(requestAuth);
			if ("token" in answer) {
				setRequestAuth({ oauth2AccessToken: answer.token });
			} else {
				setOAuth2TokenError(
					answer.error ?? t("apiExplorer:auth.oauth2.tokenError"),
				);
			}
		} catch (err) {
			setOAuth2TokenError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsGettingOAuth2Token(false);
		}
	}

	return (
		<div className="space-y-4">
			{/* Auth type selector */}
			<div>
				<label htmlFor={`${idBase}-1`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">
					{t("apiExplorer:auth.type")}
				</label>
				<CustomSelect
					id={`${idBase}-1`}
					value={requestAuth.type}
					onChange={(v) => setRequestAuth({ type: v as AuthType })}
					options={(
						[
							"inherited",
							"none",
							"bearer",
							"basic",
							"apikey",
							"oauth2",
						] as AuthType[]
					).map((type) => ({
						value: type,
						label: t(`apiExplorer:auth.types.${type}`),
					}))}
				/>
			</div>

			{/* Inherited from environment */}
			{requestAuth.type === "inherited" && (
				<div
					className={`rounded-lg p-3 text-xs ${activeEnv?.token ? "bg-warning/5 border border-warning/20" : "bg-card border border-[var(--color-border)]"}`}
				>
					{activeEnv?.token ? (
						<div className="flex items-start gap-2">
							<span className="text-warning mt-0.5">🔑</span>
							<div>
								<div className="font-medium text-warning">
									{t("apiExplorer:auth.inheritedFrom", {
										env: activeEnv.name,
									})}
								</div>
								<div className="text-muted-foreground mt-0.5 font-mono">
									Authorization: Bearer ••••{activeEnv.token.slice(-6)}
								</div>
							</div>
						</div>
					) : (
						<div className="text-muted-foreground">
							{t("apiExplorer:auth.noEnvToken", {
								env: activeEnv?.name ?? t("apiExplorer:environments.defaultName"),
							})}
							<button
								type="button"
								onClick={onOpenEnvManager}
								className="ml-1 text-[var(--color-primary)] hover:underline focus:outline-none font-medium"
							>
								{t("apiExplorer:auth.configureEnv")}
							</button>
						</div>
					)}
				</div>
			)}

			{/* No auth */}
			{requestAuth.type === "none" && (
				<div className="text-xs text-muted-foreground bg-card border border-[var(--color-border)] rounded-lg p-3">
					{t("apiExplorer:auth.noAuthDesc")}
				</div>
			)}

			{/* Bearer Token */}
			{requestAuth.type === "bearer" && (
				<div className="space-y-2">
					<label htmlFor={`${idBase}-2`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block">
						{t("apiExplorer:auth.token")}
					</label>
					<div className="flex gap-2">
						<input
							id={`${idBase}-2`}
							type={showAuthToken ? "text" : "password"}
							className="flex-1 bg-card border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-[var(--color-accent)]"
							value={requestAuth.bearer}
							onChange={(e) =>
								setRequestAuth({ bearer: e.target.value })
							}
							placeholder={t("apiExplorer:auth.tokenPlaceholder")}
						/>
						<button
							type="button"
							onClick={() => setShowAuthToken((v) => !v)}
							aria-label={t("apiExplorer:aria.showSecret")}
							aria-pressed={showAuthToken}
							className="px-3 text-muted-foreground hover:text-foreground border border-[var(--color-border)] rounded-md bg-card transition-colors text-sm"
						>
							{showAuthToken ? <EyeOff size={13} /> : <Eye size={13} />}
						</button>
					</div>
					<div className="text-3xs text-muted-foreground">
						{t("apiExplorer:auth.bearerHint")}
					</div>
				</div>
			)}

			{/* Basic Auth */}
			{requestAuth.type === "basic" && (
				<div className="space-y-2">
					<div>
						<label htmlFor={`${idBase}-3`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
							{t("apiExplorer:auth.username")}
						</label>
						<Input
							id={`${idBase}-3`}
							type="text"
							className="w-full px-3 py-2 text-sm h-auto"
							value={requestAuth.username}
							onChange={(e) =>
								setRequestAuth({ username: e.target.value })
							}
							placeholder={t("apiExplorer:auth.usernamePlaceholder")}
						/>
					</div>
					<div>
						<label htmlFor={`${idBase}-4`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
							{t("apiExplorer:auth.password")}
						</label>
						<div className="flex gap-2">
							<input
								id={`${idBase}-4`}
								type={showAuthPassword ? "text" : "password"}
								className="flex-1 bg-card border border-[var(--color-border)] rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-[var(--color-accent)]"
								value={requestAuth.password}
								onChange={(e) =>
									setRequestAuth({ password: e.target.value })
								}
								placeholder="••••••••"
							/>
							<button
								type="button"
								onClick={() => setShowAuthPassword((v) => !v)}
								aria-label={t("apiExplorer:aria.showSecret")}
								aria-pressed={showAuthPassword}
								className="px-3 text-muted-foreground hover:text-foreground border border-[var(--color-border)] rounded-md bg-card transition-colors text-sm"
							>
								{showAuthPassword ? <EyeOff size={13} /> : <Eye size={13} />}
							</button>
						</div>
					</div>
					<div className="text-3xs text-muted-foreground">
						{t("apiExplorer:auth.basicHint")}
					</div>
				</div>
			)}

			{/* API Key */}
			{requestAuth.type === "apikey" && (
				<div className="space-y-2">
					<div className="grid grid-cols-2 gap-2">
						<div>
							<label htmlFor={`${idBase}-5`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
								{t("apiExplorer:auth.keyName")}
							</label>
							<Input
								id={`${idBase}-5`}
								spellCheck={false}
								type="text"
								className="w-full px-3 py-2 text-sm font-mono h-auto"
								value={requestAuth.keyName}
								onChange={(e) =>
									setRequestAuth({ keyName: e.target.value })
								}
								placeholder="X-API-Key"
							/>
						</div>
						<div>
							<label htmlFor={`${idBase}-6`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
								{t("apiExplorer:auth.addTo")}
							</label>
							<CustomSelect
								id={`${idBase}-6`}
								value={requestAuth.keyLocation}
								onChange={(v) =>
									setRequestAuth({
										keyLocation: v as "header" | "query",
									})
								}
								options={[
									{
										value: "header",
										label: t("apiExplorer:auth.locationHeader"),
									},
									{
										value: "query",
										label: t("apiExplorer:auth.locationQuery"),
									},
								]}
							/>
						</div>
					</div>
					<div>
						<label htmlFor={`${idBase}-7`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
							{t("apiExplorer:auth.keyValue")}
						</label>
						<Input
							id={`${idBase}-7`}
							spellCheck={false}
							type="text"
							className="w-full px-3 py-2 text-sm font-mono h-auto"
							value={requestAuth.keyValue}
							onChange={(e) =>
								setRequestAuth({ keyValue: e.target.value })
							}
							placeholder={t("apiExplorer:auth.keyValuePlaceholder")}
						/>
					</div>
				</div>
			)}

			{/* OAuth 2.0 */}
			{requestAuth.type === "oauth2" && (
				<div className="space-y-3">
					{/* Grant Type */}
					<div>
						<label htmlFor={`${idBase}-8`} className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
							{t("apiExplorer:auth.oauth2.grantType")}
						</label>
						<CustomSelect
							id={`${idBase}-8`}
							value={requestAuth.oauth2GrantType}
							onChange={(v) =>
								setRequestAuth({
									oauth2GrantType: v as OAuth2GrantType,
								})
							}
							options={[
								{
									value: "client_credentials",
									label: t(
										"apiExplorer:auth.oauth2.grants.client_credentials",
									),
								},
								{
									value: "authorization_code",
									label: t(
										"apiExplorer:auth.oauth2.grants.authorization_code",
									),
								},
								{
									value: "password",
									label: t("apiExplorer:auth.oauth2.grants.password"),
								},
							]}
						/>
					</div>

					{/* Configure New Token */}
					<div className="border border-[var(--color-border)] rounded-lg p-3 space-y-2.5">
						<div className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider">
							{t("apiExplorer:auth.oauth2.configureToken")}
						</div>

						{/* Auth URL — only for authorization_code */}
						{requestAuth.oauth2GrantType === "authorization_code" && (
							<div>
								<label htmlFor={`${idBase}-9`} className="text-3xs text-muted-foreground block mb-1">
									{t("apiExplorer:auth.oauth2.authUrl")}
								</label>
								<Input
									id={`${idBase}-9`}
									spellCheck={false}
									type="url"
									className="w-full px-3 py-1.5 text-xs font-mono h-auto"
									value={requestAuth.oauth2AuthUrl}
									onChange={(e) =>
										setRequestAuth({ oauth2AuthUrl: e.target.value })
									}
									placeholder="https://auth.example.com/authorize"
								/>
							</div>
						)}

						{/* Token URL */}
						{requestAuth.oauth2GrantType !== "authorization_code" && (
							<div>
								<label htmlFor={`${idBase}-10`} className="text-3xs text-muted-foreground block mb-1">
									{t("apiExplorer:auth.oauth2.tokenUrl")}
								</label>
								<Input
									id={`${idBase}-10`}
									spellCheck={false}
									type="url"
									className="w-full px-3 py-1.5 text-xs font-mono h-auto"
									value={requestAuth.oauth2TokenUrl}
									onChange={(e) =>
										setRequestAuth({ oauth2TokenUrl: e.target.value })
									}
									placeholder="https://auth.example.com/token"
								/>
							</div>
						)}

						{/* Client ID */}
						<div>
							<label htmlFor={`${idBase}-11`} className="text-3xs text-muted-foreground block mb-1">
								{t("apiExplorer:auth.oauth2.clientId")}
							</label>
							<Input
								id={`${idBase}-11`}
								spellCheck={false}
								type="text"
								className="w-full px-3 py-1.5 text-xs font-mono h-auto"
								value={requestAuth.oauth2ClientId}
								onChange={(e) =>
									setRequestAuth({ oauth2ClientId: e.target.value })
								}
								placeholder="client_id"
							/>
						</div>

						{/* Client Secret */}
						<div>
							<label htmlFor={`${idBase}-12`} className="text-3xs text-muted-foreground block mb-1">
								{t("apiExplorer:auth.oauth2.clientSecret")}
							</label>
							<div className="flex gap-2">
								<input
									id={`${idBase}-12`}
									type={showOAuth2Secret ? "text" : "password"}
									className="flex-1 bg-background border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-[var(--color-accent)]"
									value={requestAuth.oauth2ClientSecret}
									onChange={(e) =>
										setRequestAuth({
											oauth2ClientSecret: e.target.value,
										})
									}
									placeholder="client_secret"
								/>
								<button
									type="button"
									onClick={() => setShowOAuth2Secret((v) => !v)}
									aria-label={t("apiExplorer:aria.showSecret")}
									aria-pressed={showOAuth2Secret}
									className="px-2.5 text-muted-foreground hover:text-foreground border border-[var(--color-border)] rounded-md bg-background transition-colors text-sm"
								>
									{showOAuth2Secret ? <EyeOff size={13} /> : <Eye size={13} />}
								</button>
							</div>
						</div>

						{/* Scope */}
						<div>
							<label htmlFor={`${idBase}-13`} className="text-3xs text-muted-foreground block mb-1">
								{t("apiExplorer:auth.oauth2.scope")}
							</label>
							<Input
								id={`${idBase}-13`}
								spellCheck={false}
								type="text"
								className="w-full px-3 py-1.5 text-xs font-mono h-auto"
								value={requestAuth.oauth2Scope}
								onChange={(e) =>
									setRequestAuth({ oauth2Scope: e.target.value })
								}
								placeholder="openid profile email"
							/>
						</div>

						{/* Password fields — only for password grant */}
						{requestAuth.oauth2GrantType === "password" && (
							<div className="grid grid-cols-2 gap-2">
								<div>
									<label htmlFor={`${idBase}-14`} className="text-3xs text-muted-foreground block mb-1">
										{t("apiExplorer:auth.username")}
									</label>
									<Input
										id={`${idBase}-14`}
										type="text"
										className="w-full px-3 py-1.5 text-xs h-auto"
										value={requestAuth.username}
										onChange={(e) =>
											setRequestAuth({ username: e.target.value })
										}
										placeholder={t(
											"apiExplorer:auth.usernamePlaceholder",
										)}
									/>
								</div>
								<div>
									<label htmlFor={`${idBase}-15`} className="text-3xs text-muted-foreground block mb-1">
										{t("apiExplorer:auth.password")}
									</label>
									<Input
										id={`${idBase}-15`}
										type="password"
										className="w-full px-3 py-1.5 text-xs h-auto"
										value={requestAuth.password}
										onChange={(e) =>
											setRequestAuth({ password: e.target.value })
										}
										placeholder="••••••••"
									/>
								</div>
							</div>
						)}

						{/* Error */}
						{oauth2TokenError && (
							<div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-2.5 py-1.5">
								{oauth2TokenError}
							</div>
						)}

						{/* Get Token button */}
						<button
							type="button"
							onClick={handleGetOAuth2Token}
							disabled={isGettingOAuth2Token}
							className="w-full py-2 rounded-md text-xs font-semibold bg-[var(--color-primary)] text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
						>
							{isGettingOAuth2Token && (
								<Loader2 size={12} className="animate-spin" />
							)}
							{requestAuth.oauth2GrantType === "authorization_code"
								? t("apiExplorer:auth.oauth2.openBrowser")
								: t("apiExplorer:auth.oauth2.getToken")}
						</button>
					</div>

					{/* Current Token */}
					<div className="space-y-2">
						<div className="text-3xs font-semibold text-muted-foreground uppercase tracking-wider">
							{t("apiExplorer:auth.oauth2.currentToken")}
						</div>
						<div className="flex gap-2">
							<input
								type={showOAuth2Token ? "text" : "password"}
								className="flex-1 bg-card border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-[var(--color-accent)]"
								value={requestAuth.oauth2AccessToken}
								onChange={(e) =>
									setRequestAuth({ oauth2AccessToken: e.target.value })
								}
								placeholder={t(
									"apiExplorer:auth.oauth2.tokenPlaceholder",
								)}
							/>
							<button
								type="button"
								onClick={() => setShowOAuth2Token((v) => !v)}
								aria-label={t("apiExplorer:aria.showSecret")}
								aria-pressed={showOAuth2Token}
								className="px-3 text-muted-foreground hover:text-foreground border border-[var(--color-border)] rounded-md bg-card transition-colors text-sm"
							>
								{showOAuth2Token ? <EyeOff size={13} /> : <Eye size={13} />}
							</button>
						</div>
						<div className="flex items-center gap-2">
							<span className="text-3xs text-muted-foreground">
								{t("apiExplorer:auth.oauth2.headerPrefix")}
							</span>
							<Input
								spellCheck={false}
								type="text"
								className="w-24 px-2 py-1 text-xs font-mono h-auto"
								value={requestAuth.oauth2HeaderPrefix}
								onChange={(e) =>
									setRequestAuth({ oauth2HeaderPrefix: e.target.value })
								}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
