/**
 * The project's MCP install policy, as the marketplace explains it (#369,
 * lot 2). The main process reads `.workpilot/mcp-policy.json` and applies it
 * when the project's settings are written; here it only hides the Install
 * button of a server it refuses, and says why.
 */

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { policyRefusal } from "../../../shared/mcp-catalog/install-policy";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type { McpPolicyRefusal, McpPolicyState } from "../../../shared/types/mcp-policy";
import type { McpSecurityScore } from "../../../shared/types/mcp-security";
import { useMcpMarketplaceStore } from "../../stores/mcp-marketplace-store";
import { Notice } from "../charter";

/** The policy of `projectId`, once the main has read it. */
function usePolicy(projectId: string | null): McpPolicyState | null {
	return useMcpMarketplaceStore((s) =>
		projectId && s.policyProjectId === projectId ? s.policy : null,
	);
}

/**
 * Why the policy of `projectId` refuses catalog server `server`, or null.
 * The score counts only once the main has read the registry: the local one
 * is a guess the main may correct.
 */
export function useCatalogPolicyRefusal(
	server: McpMarketplaceServer,
	projectId: string | null,
	score: McpSecurityScore,
): McpPolicyRefusal | null {
	const policy = usePolicy(projectId);
	if (!policy) return null;
	return policyRefusal(policy, {
		serverId: server.id,
		name: server.name,
		entry: server,
		...(score.checked ? { score: score.score } : {}),
	});
}

/** One sentence for a refusal, in the app's language. */
export function McpPolicyRefusalText({ refusal }: { readonly refusal: McpPolicyRefusal }) {
	const { t } = useTranslation(["common"]);
	return (
		<>
			{t(`mcpMarketplace.policy.refusals.${refusal.reason}`, {
				name: refusal.name,
				score: refusal.score,
				minScore: refusal.minScore,
			})}
		</>
	);
}

/**
 * A save the policy refused, outside the marketplace (Agent Tools): the
 * main wrote nothing, the view put the previous list back, this says why.
 */
export function McpPolicyRefusalNotice({
	refusal,
	className,
}: {
	readonly refusal: McpPolicyRefusal;
	readonly className?: string;
}) {
	return (
		<Notice tone="red" icon={ShieldAlert} role="alert" className={className}>
			<p>
				<McpPolicyRefusalText refusal={refusal} />
			</p>
		</Notice>
	);
}

/** The policy of the selected project, above the catalog and the installed list. */
export function McpPolicyBanner({
	projectId,
	className,
}: {
	readonly projectId: string | null;
	readonly className?: string;
}) {
	const { t } = useTranslation(["common"]);
	const policy = usePolicy(projectId);
	if (!policy || policy.state === "none") return null;

	if (policy.state === "invalid") {
		const why =
			policy.reason === "schema" && policy.field
				? t("mcpMarketplace.policy.invalid.schemaField", { field: policy.field })
				: t(`mcpMarketplace.policy.invalid.${policy.reason}`);
		return (
			<Notice tone="red" icon={ShieldAlert} role="alert" className={className}>
				<p>{t("mcpMarketplace.policy.invalidTitle")}</p>
				<p className="text-xs opacity-80">{why}</p>
			</Notice>
		);
	}

	const { allowedServers, minScore, blockCustomServers, acceptedFindings } = policy.policy;
	return (
		<Notice tone="blue" icon={ShieldCheck} className={className}>
			<p>{t("mcpMarketplace.policy.active")}</p>
			{allowedServers && (
				<p className="text-xs opacity-80">
					{allowedServers.length > 0
						? t("mcpMarketplace.policy.allowed", { ids: allowedServers.join(", ") })
						: t("mcpMarketplace.policy.allowedNone")}
				</p>
			)}
			{minScore !== undefined && (
				<p className="text-xs opacity-80">{t("mcpMarketplace.policy.minScore", { min: minScore })}</p>
			)}
			{blockCustomServers && (
				<p className="text-xs opacity-80">{t("mcpMarketplace.policy.customBlocked")}</p>
			)}
			{acceptedFindings && acceptedFindings.length > 0 && (
				<p className="text-xs opacity-80">
					{t("mcpMarketplace.policy.acceptedFindings", { count: acceptedFindings.length })}
				</p>
			)}
		</Notice>
	);
}
