import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { providerRegistry } from "../../../shared/services/providerRegistry";
/**
 * AddAgentDialog — Dialog for creating a new agent slot in Mission Control.
 *
 * Allows selecting: name, role, provider, and model.
 */

import { Brain, Cpu, Rocket, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface AddAgentDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onAdd: (
		name: string,
		role: string,
		provider: string,
		model: string,
		modelLabel: string,
	) => void;
}

const ROLES = [
	{
		value: "architect",
		label: "🏗️ Architect",
		desc: "System design & architecture",
	},
	{ value: "coder", label: "💻 Coder", desc: "Code implementation" },
	{ value: "tester", label: "🧪 Tester", desc: "Testing & QA" },
	{ value: "reviewer", label: "👁️ Reviewer", desc: "Code review" },
	{ value: "documenter", label: "📝 Documenter", desc: "Documentation" },
	{ value: "planner", label: "📋 Planner", desc: "Task planning" },
	{ value: "debugger", label: "🐛 Debugger", desc: "Bug fixing" },
	{ value: "custom", label: "⚙️ Custom", desc: "Custom role" },
];

const PROVIDERS = providerRegistry
	.getAllProviders()
	.map((p) => ({ value: p.name, label: p.label }));

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

export function AddAgentDialog({
	open,
	onOpenChange,
	onAdd,
}: AddAgentDialogProps) {
	const { t } = useTranslation(["missionControl"]);
	const [name, setName] = useState("");
	const [role, setRole] = useState("coder");
	const [provider, setProvider] = useState("anthropic");
	const [model, setModel] = useState("");
	const { models } = useProviderModelCatalog(provider);

	// Provider/role changes reset the choice; catalog refreshes preserve it.
	useEffect(() => {
		if (!model) {
			const recommended = models.find(
				(m) => m.tier === (ROLE_TIER_MAP[role] ?? "standard"),
			);
			setModel(recommended?.value ?? models[0]?.value ?? "");
		}
	}, [model, models, role]);

	// Auto-generate name from role
	useEffect(() => {
		if (!name || ROLES.some((r) => name === `Agent ${r.label.split(" ")[1]}`)) {
			const roleData = ROLES.find((r) => r.value === role);
			if (roleData) {
				setName(`Agent ${roleData.label.split(" ")[1]}`);
			}
		}
	}, [role, name]);

	const modelData = models.find((m) => m.value === model);

	const handleSubmit = () => {
		if (!name.trim()) return;
		onAdd(name.trim(), role, provider, model, modelData?.label ?? model);
		// Reset form
		setName("");
		setRole("coder");
		setProvider("anthropic");
		setModel("");
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Rocket className="h-5 w-5 text-primary" />
						{t("missionControl:addAgentTitle", "Add Agent")}
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-4 py-2">
					{/* Name */}
					<div className="space-y-2">
						<Label className="flex items-center gap-1.5 text-xs">
							<User className="h-3.5 w-3.5" />
							{t("missionControl:agentName", "Agent Name")}
						</Label>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Architecture Agent"
							className="text-sm"
						/>
					</div>

					{/* Role */}
					<div className="space-y-2">
						<Label className="flex items-center gap-1.5 text-xs">
							<Brain className="h-3.5 w-3.5" />
							{t("missionControl:agentRole", "Role")}
						</Label>
						<Select
							value={role}
							onValueChange={(value) => {
								setRole(value);
								setModel("");
							}}
						>
							<SelectTrigger className="text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{ROLES.map((r) => (
									<SelectItem key={r.value} value={r.value}>
										<div className="flex items-center gap-2">
											<span>{r.label}</span>
											<span className="text-xs text-muted-foreground">
												{r.desc}
											</span>
										</div>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Provider */}
					<div className="space-y-2">
						<Label className="flex items-center gap-1.5 text-xs">
							<Cpu className="h-3.5 w-3.5" />
							{t("missionControl:provider", "Provider")}
						</Label>
						<Select
							value={provider}
							onValueChange={(value) => {
								setProvider(value);
								setModel("");
							}}
						>
							<SelectTrigger className="text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
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
						<Label className="flex items-center gap-1.5 text-xs">
							<Cpu className="h-3.5 w-3.5" />
							{t("missionControl:model", "Model")}
							{modelData && (
								<span className="ml-auto text-[10px] text-muted-foreground capitalize">
									{modelData.tier}
								</span>
							)}
						</Label>
						<Select value={model} onValueChange={setModel}>
							<SelectTrigger className="text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{models.map((m) => (
									<SelectItem key={m.value} value={m.value}>
										<div className="flex items-center gap-2">
											<span>{m.label}</span>
											<span
												className={`text-[10px] capitalize px-1 rounded ${
													m.tier === "flagship"
														? "bg-amber-500/10 text-amber-600"
														: m.tier === "fast"
															? "bg-green-500/10 text-green-600"
															: "bg-blue-500/10 text-blue-600"
												}`}
											>
												{m.tier}
											</span>
										</div>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("common:cancel", "Cancel")}
					</Button>
					<Button onClick={handleSubmit} disabled={!name.trim()}>
						<Rocket className="h-4 w-4 mr-1.5" />
						{t("missionControl:createAgent", "Create Agent")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
