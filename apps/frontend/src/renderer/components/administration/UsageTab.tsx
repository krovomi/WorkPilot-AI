/**
 * Usage (`usage.read`): the figures of the organization (or, for a platform
 * administrator, of the whole deployment), and what the server collects and
 * how long it keeps it.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import { UsageDashboard } from "./usage/UsageDashboard";
import { UsageSettings } from "./usage/UsageSettings";

const PANES = ["dashboard", "settings"] as const;
type Pane = (typeof PANES)[number];

export function UsageTab() {
	const { t } = useTranslation("administration");
	const [pane, setPane] = useState<Pane>("dashboard");
	return (
		<div className="space-y-4">
			<div className="flex gap-2" role="tablist">
				{PANES.map((p) => (
					<Button
						key={p}
						size="sm"
						role="tab"
						aria-selected={pane === p}
						variant={pane === p ? "default" : "outline"}
						onClick={() => setPane(p)}
					>
						{t(`usage.panes.${p}`)}
					</Button>
				))}
			</div>
			{pane === "dashboard" ? <UsageDashboard /> : <UsageSettings />}
		</div>
	);
}
