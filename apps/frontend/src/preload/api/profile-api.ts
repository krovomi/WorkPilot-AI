import type {
	APIProfile,
	DiscoverModelsResult,
	ProfileFormData,
	ProfilesFile,
	TestConnectionResult,
} from "@shared/types/profile";
import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";

export interface ProfileAPI {
	// Get all profiles
	getAPIProfiles: () => Promise<IPCResult<ProfilesFile>>;

	// Save/create a profile
	saveAPIProfile: (profile: ProfileFormData) => Promise<IPCResult<APIProfile>>;

	// Update an existing profile
	updateAPIProfile: (profile: APIProfile) => Promise<IPCResult<APIProfile>>;

	// Delete a profile
	deleteAPIProfile: (profileId: string) => Promise<IPCResult>;

	// Set active profile (null to switch to OAuth)
	setActiveAPIProfile: (profileId: string | null) => Promise<IPCResult>;

	// Test API profile connection. A masked key (the one PROFILES_GET hands out)
	// needs profileId: main uses that profile's stored key, for its own URL only.
	testConnection: (
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal,
		profileId?: string,
	) => Promise<IPCResult<TestConnectionResult>>;

	// Discover available models from API
	discoverModels: (
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal,
		profileId?: string,
	) => Promise<IPCResult<DiscoverModelsResult>>;
}

let testConnectionRequestId = 0;
let discoverModelsRequestId = 0;

export const createProfileAPI = (): ProfileAPI => ({
	// Get all profiles
	getAPIProfiles: (): Promise<IPCResult<ProfilesFile>> =>
		ipcRenderer.invoke(IPC_CHANNELS.PROFILES_GET),

	// Save/create a profile
	saveAPIProfile: (profile: ProfileFormData): Promise<IPCResult<APIProfile>> =>
		ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SAVE, profile),

	// Update an existing profile
	updateAPIProfile: (profile: APIProfile): Promise<IPCResult<APIProfile>> =>
		ipcRenderer.invoke(IPC_CHANNELS.PROFILES_UPDATE, profile),

	// Delete a profile
	deleteAPIProfile: (profileId: string): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.PROFILES_DELETE, profileId),

	// Set active profile (null to switch to OAuth)
	setActiveAPIProfile: (profileId: string | null): Promise<IPCResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SET_ACTIVE, profileId),

	// Test API profile connection
	testConnection: (
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal,
		profileId?: string,
	): Promise<IPCResult<TestConnectionResult>> => {
		const requestId = ++testConnectionRequestId;

		// Check if already aborted before initiating request
		if (signal?.aborted) {
			return Promise.reject(
				new DOMException("The operation was aborted.", "AbortError"),
			);
		}

		// Setup abort listener AFTER checking aborted status to avoid race condition
		if (signal && typeof signal.addEventListener === "function") {
			try {
				signal.addEventListener(
					"abort",
					() => {
						ipcRenderer.send(
							IPC_CHANNELS.PROFILES_TEST_CONNECTION_CANCEL,
							requestId,
						);
					},
					{ once: true },
				);
			} catch (err) {
				console.error(
					"[preload/profile-api] Error adding abort listener:",
					err,
				);
			}
		} else if (signal) {
			console.warn(
				"[preload/profile-api] signal provided but addEventListener not available - signal may have been serialized",
			);
		}

		return ipcRenderer.invoke(
			IPC_CHANNELS.PROFILES_TEST_CONNECTION,
			baseUrl,
			apiKey,
			requestId,
			profileId,
		);
	},

	// Discover available models from API
	discoverModels: (
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal,
		profileId?: string,
	): Promise<IPCResult<DiscoverModelsResult>> => {
		const requestId = ++discoverModelsRequestId;

		// Check if already aborted before initiating request
		if (signal?.aborted) {
			return Promise.reject(
				new DOMException("The operation was aborted.", "AbortError"),
			);
		}

		// Setup abort listener AFTER checking aborted status to avoid race condition
		if (signal && typeof signal.addEventListener === "function") {
			try {
				signal.addEventListener(
					"abort",
					() => {
						ipcRenderer.send(
							IPC_CHANNELS.PROFILES_DISCOVER_MODELS_CANCEL,
							requestId,
						);
					},
					{ once: true },
				);
			} catch (err) {
				console.error(
					"[preload/profile-api] Error adding abort listener:",
					err,
				);
			}
		} else if (signal) {
			console.warn(
				"[preload/profile-api] signal provided but addEventListener not available - signal may have been serialized",
			);
		}

		return ipcRenderer.invoke(
			IPC_CHANNELS.PROFILES_DISCOVER_MODELS,
			baseUrl,
			apiKey,
			requestId,
			profileId,
		);
	},
});
