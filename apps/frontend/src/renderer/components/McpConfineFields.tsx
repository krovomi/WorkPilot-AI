/**
 * Whether a custom command MCP server runs confined, and which hosts it may
 * reach (#369, lot 5). The backend starts a confined server only in the OS
 * sandbox, with these hosts and its launcher's registry on the network, and
 * refuses a host it cannot read (`apps/backend/core/mcp_confinement.py`);
 * the project's MCP policy may confine a server whatever this says.
 */

import { useTranslation } from "react-i18next";
import type { McpServerConfinement } from "../../shared/types";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** The hosts typed, separated by spaces or commas. */
export function parseConfineHosts(text: string): string[] {
	return text.split(/[\s,]+/).filter(Boolean);
}

/** `confine` as the dialog saves it: absent when the box is not ticked. */
export function confinementToSave(
	confined: boolean,
	hostsInput: string,
): { confine?: McpServerConfinement } {
	return confined ? { confine: { hosts: parseConfineHosts(hostsInput) } } : {};
}

interface McpConfineFieldsProps {
	readonly confined: boolean;
	readonly hostsInput: string;
	readonly onConfinedChange: (confined: boolean) => void;
	readonly onHostsChange: (hosts: string) => void;
}

export function McpConfineFields({
	confined,
	hostsInput,
	onConfinedChange,
	onHostsChange,
}: McpConfineFieldsProps) {
	const { t } = useTranslation(["settings"]);
	return (
		<div className="space-y-2 rounded-lg border border-border p-3">
			<div className="flex items-start gap-2">
				<Checkbox
					id="mcp-confine"
					checked={confined}
					onCheckedChange={(value) => onConfinedChange(value === true)}
				/>
				<div className="space-y-1">
					<Label htmlFor="mcp-confine">{t("settings:mcp.confine.label")}</Label>
					<p className="text-xs text-muted-foreground">{t("settings:mcp.confine.hint")}</p>
				</div>
			</div>
			{confined && (
				<div className="space-y-2">
					<Label htmlFor="mcp-confine-hosts">{t("settings:mcp.confine.hosts")}</Label>
					<Input
						id="mcp-confine-hosts"
						value={hostsInput}
						onChange={(e) => onHostsChange(e.target.value)}
						placeholder="api.example.com"
					/>
					<p className="text-xs text-muted-foreground">
						{t("settings:mcp.confine.hostsHint")}
					</p>
				</div>
			)}
		</div>
	);
}
