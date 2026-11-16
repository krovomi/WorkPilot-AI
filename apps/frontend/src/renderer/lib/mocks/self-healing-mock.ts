/**
 * Self-healing in the browser preview: nothing to scan or bisect, an empty
 * dashboard, and every action reports that it needs the desktop app.
 */
import type { SelfHealingAPIObject } from "../../../preload/api/modules/self-healing-api";

const unavailable = async () => ({
	success: false,
	error: "Not available in browser mode",
});
const noListener = () => () => {
	/* nothing to remove in the browser mock */
};

const selfHealing: SelfHealingAPIObject = {
	getDashboard: async () => ({ success: false }),
	getIncidents: async () => ({ success: true, data: [] }),
	getOperations: async () => ({ success: true, data: [] }),
	getFragility: async () => ({ success: true, data: [] }),
	cicdEnable: unavailable,
	cicdDisable: unavailable,
	cicdConfig: unavailable,
	productionConnect: unavailable,
	productionDisconnect: unavailable,
	productionConfig: unavailable,
	proactiveScan: unavailable,
	proactiveConfig: unavailable,
	triggerFix: unavailable,
	cancelOperation: unavailable,
	dismissIncident: unavailable,
	retryIncident: unavailable,
	bisectIncident: unavailable,
	onOperationProgress: noListener,
	onOperationComplete: noListener,
	onBisectProgress: noListener,
};

export const selfHealingMock = { selfHealing };
