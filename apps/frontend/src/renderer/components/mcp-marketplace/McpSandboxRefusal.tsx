/**
 * Said next to an MCP server that must run confined when this machine has no
 * OS sandbox (#369, lot 6): the backend does not start it, and never starts
 * it without the sandbox (`apps/backend/core/mcp_confinement.py`). "Why?"
 * names what is missing, in the app's language, with the backend's English
 * detail as text. Nothing is shown while the sandbox works, nor for a server
 * that is not confined.
 */

import { ShieldOff } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { CustomMcpServer } from "../../../shared/types";
import type { McpSandboxStatus } from "../../../shared/types/mcp-sandbox";
import { cn } from "../../lib/utils";
import { useMcpSandboxStore } from "../../stores/mcp-sandbox-store";
import { Button } from "../ui/button";

/** The machine's answer, asked once for every view; null while unknown. */
function useUnavailableSandbox(active: boolean): McpSandboxStatus | null {
	const status = useMcpSandboxStore((s) => s.status);
	const load = useMcpSandboxStore((s) => s.load);
	useEffect(() => {
		if (active) void load();
	}, [active, load]);
	return active && status && !status.available ? status : null;
}

function SandboxWhy({ status }: { readonly status: McpSandboxStatus }) {
	const { t } = useTranslation(["common"]);
	const checking = useMcpSandboxStore((s) => s.checking);
	const load = useMcpSandboxStore((s) => s.load);
	return (
		<details className="mt-1" data-testid="mcp-sandbox-why">
			<summary className="cursor-pointer">{t("common:mcpMarketplace.sandbox.why")}</summary>
			<p className="mt-1">
				{t(`common:mcpMarketplace.sandbox.kinds.${status.kind}`, {
					backend: status.backend ?? "",
				})}
			</p>
			{status.reason && <p className="mt-1 break-words opacity-80">{status.reason}</p>}
			<Button
				variant="ghost"
				size="sm"
				className="mt-1 h-6 px-2 text-xs"
				disabled={checking}
				onClick={() => void load(true)}
			>
				{t("common:mcpMarketplace.sandbox.recheck")}
			</Button>
		</details>
	);
}

interface McpConfinedRefusalProps {
	readonly server: CustomMcpServer;
	readonly className?: string;
}

/** Next to a confined server: it does not start here, and why. */
export function McpConfinedRefusal({ server, className }: McpConfinedRefusalProps) {
	const { t } = useTranslation(["common"]);
	const confined = server.type === "command" && server.confine !== undefined;
	const status = useUnavailableSandbox(confined);
	if (!status) return null;
	return (
		<div
			role="note"
			className={cn("text-xs text-warning", className)}
			data-testid="mcp-confined-refusal"
		>
			<p className="flex items-start gap-1">
				<ShieldOff className="mt-0.5 h-3 w-3 shrink-0" />
				<span>{t("common:mcpMarketplace.sandbox.refused")}</span>
			</p>
			<SandboxWhy status={status} />
		</div>
	);
}

/** In the policy banner, when it confines servers and this machine cannot. */
export function McpPolicySandboxLine() {
	const { t } = useTranslation(["common"]);
	const status = useUnavailableSandbox(true);
	if (!status) return null;
	return (
		<div className="text-xs" data-testid="mcp-policy-sandbox">
			<p>{t("common:mcpMarketplace.sandbox.policyRefused")}</p>
			<SandboxWhy status={status} />
		</div>
	);
}
