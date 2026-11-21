/**
 * AddAgentDialog — Dialog for creating a new agent slot in Mission Control.
 *
 * Allows selecting: name, role, provider, and model — or, under
 * "Auto-compose", a whole crew suggested from the work (#344). The dialog
 * stays open, with what was typed, until the agent exists; a refusal is shown
 * in it.
 */

import { AlertTriangle, Brain, Cpu, Rocket, User, Wand2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { providerRegistry } from "../../../shared/services/providerRegistry";
import type { MissionControlPlannedAgent } from "../../../shared/types/mission-control";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { useMissionControlStore } from "../../stores/mission-control-store";
import { Notice, Tabs } from "../charter";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import "../charter/charter.css";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { AGENT_ROLES } from "./agent-format";
import { AutoComposePanel } from "./AutoComposePanel";

type Mode = "manual" | "auto";

interface AddAgentDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** Resolves true once the agent exists. */
	readonly onAdd: (name: string, role: string, provider: string, model: string, modelLabel: string) => Promise<boolean>;
	/** Why the last creation was refused ("" without a reason); null when nothing was. */
	readonly error?: string | null;
}

const PROVIDERS = providerRegistry.getAllProviders().map((p) => ({ value: p.name, label: p.label }));

const ROLE_TIER_MAP: Record<string, string> = {
	architect: "flagship",
	planner: "flagship",
	coder: "standard",
	reviewer: "standard",
	debugger: "standard",
	tester: "fast",
	documenter: "fast",
	custom: "standard",
};

const TIER_CLASSES: Record<string, string> = {
	flagship: "bg-warning/10 text-warning",
	fast: "bg-success/10 text-success",
};

export function AddAgentDialog({ open, onOpenChange, onAdd, error }: AddAgentDialogProps) {
	const { t } = useTranslation(["missionControl", "navigation", "common"]);
	const ids = useId();
	// null: the name follows the role until the person types one.
	const [customName, setCustomName] = useState<string | null>(null);
	const [role, setRole] = useState("coder");
	const [provider, setProvider] = useState("anthropic");
	const [model, setModel] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const { models } = useProviderModelCatalog(provider);
	const [mode, setMode] = useState<Mode>("manual");
	const createAgent = useMissionControlStore((s) => s.createAgent);

	// One agent per role of the crew, in its order; the dialog closes once all
	// exist, and stays open on the first refusal.
	const applyCrew = async (agents: MissionControlPlannedAgent[]) => {
		for (const agent of agents) {
			const roleName = t(`missionControl:roles.${agent.role}`);
			const created = await createAgent(
				t("missionControl:compose.agentName", { role: roleName, n: agent.key.split("-").pop() }),
				agent.role,
				agent.provider,
				agent.model,
				agent.model_label,
			);
			if (!created) return;
		}
		onOpenChange(false);
	};

	const name = customName ?? t("missionControl:defaultAgentName", { role: t(`missionControl:roles.${role}`) });

	// Provider/role changes reset the choice; catalog refreshes preserve it.
	useEffect(() => {
		if (!model) {
			const recommended = models.find((m) => m.tier === ROLE_TIER_MAP[role]) ?? models[0];
			setModel(recommended?.value ?? "");
		}
	}, [model, models, role]);

	const modelData = models.find((m) => m.value === model);

	const handleSubmit = async () => {
		setSubmitting(true);
		const created = await onAdd(name.trim(), role, provider, model, modelData?.label ?? model);
		setSubmitting(false);
		if (!created) return;
		setCustomName(null);
		setRole("coder");
		setProvider("anthropic");
		setModel("");
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className={mode === "auto" ? "wp-scope sm:max-w-2xl" : "wp-scope sm:max-w-md"}>
				<DialogHeader>
					<span className="wp-kicker">{t("navigation:items.missionControl")}</span>
					<DialogTitle className="flex items-center gap-2">
						<Rocket className="h-5 w-5 text-primary" />
						{t("missionControl:addAgentTitle")}
					</DialogTitle>
				</DialogHeader>

				<Tabs<Mode>
					label={t("missionControl:compose.tabsLabel")}
					value={mode}
					onChange={setMode}
					tabs={[
						{ id: "manual", label: t("missionControl:compose.tabManual"), icon: User },
						{ id: "auto", label: t("missionControl:compose.tabAuto"), icon: Wand2 },
					]}
				/>

				{mode === "auto" && <AutoComposePanel defaultProvider={provider} onApply={applyCrew} />}

				{/* The manual form stays mounted under Auto-compose: back on its tab, nothing is lost. */}
				<div className={mode === "auto" ? "hidden" : "space-y-4 py-2"}>
					{error != null && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							{error ? t("missionControl:createError", { error }) : t("missionControl:createFailed")}
						</Notice>
					)}

					{/* Name */}
					<div className="space-y-2">
						<Label htmlFor={`${ids}-name`} className="flex items-center gap-1.5 text-xs">
							<User className="h-3.5 w-3.5" />
							{t("missionControl:agentName")}
						</Label>
						<Input
							id={`${ids}-name`}
							value={name}
							onChange={(e) => setCustomName(e.target.value)}
							placeholder={t("missionControl:agentNamePlaceholder")}
							className="text-sm"
						/>
					</div>

					{/* Role */}
					<div className="space-y-2">
						<Label htmlFor={`${ids}-role`} className="flex items-center gap-1.5 text-xs">
							<Brain className="h-3.5 w-3.5" />
							{t("missionControl:agentRole")}
						</Label>
						<Select
							value={role}
							onValueChange={(value) => {
								setRole(value);
								setModel("");
							}}
						>
							<SelectTrigger id={`${ids}-role`} className="text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{AGENT_ROLES.map((r) => (
									<SelectItem key={r.value} value={r.value}>
										<div className="flex items-center gap-2">
											<span>
												{r.emoji} {t(`missionControl:roles.${r.value}`)}
											</span>
											<span className="text-xs text-muted-foreground">
												{t(`missionControl:roleHints.${r.value}`)}
											</span>
										</div>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Provider */}
					<div className="space-y-2">
						<Label htmlFor={`${ids}-provider`} className="flex items-center gap-1.5 text-xs">
							<Cpu className="h-3.5 w-3.5" />
							{t("missionControl:provider")}
						</Label>
						<Select
							value={provider}
							onValueChange={(value) => {
								setProvider(value);
								setModel("");
							}}
						>
							<SelectTrigger id={`${ids}-provider`} className="text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent searchable>
								{PROVIDERS.map((p) => (
									<SelectItem key={p.value} value={p.value}>
										{p.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Model */}
					<div className="space-y-2">
						<Label htmlFor={`${ids}-model`} className="flex items-center gap-1.5 text-xs">
							<Cpu className="h-3.5 w-3.5" />
							{t("missionControl:model")}
							{modelData?.tier && (
								<span className="ml-auto text-3xs text-muted-foreground">
									{t(`missionControl:tiers.${modelData.tier}`)}
								</span>
							)}
						</Label>
						<Select value={model} onValueChange={setModel}>
							<SelectTrigger id={`${ids}-model`} className="text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent searchable>
								{models.map((m) => (
									<SelectItem key={m.value} value={m.value}>
										<div className="flex items-center gap-2">
											<span>{m.label}</span>
											{m.tier && (
												<span
													className={`text-3xs px-1 rounded ${TIER_CLASSES[m.tier] ?? "bg-blue-500/10 text-blue-600"}`}
												>
													{t(`missionControl:tiers.${m.tier}`)}
												</span>
											)}
										</div>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				<DialogFooter className={mode === "auto" ? "hidden" : undefined}>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("common:cancel")}
					</Button>
					<Button onClick={() => void handleSubmit()} disabled={!name.trim() || submitting}>
						<Rocket className="h-4 w-4 mr-1.5" />
						{t("missionControl:createAgent")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
