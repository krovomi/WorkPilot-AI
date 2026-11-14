import {
	type Provider,
	ProviderService,
} from "../../../../shared/services/providerService";

// La liste des connecteurs vient du main (ProviderService), comme le reste de l'UI.
export async function getAllConnectors(): Promise<
	Array<{ id: string; label: string }>
> {
	const providers = await ProviderService.getAllProviders();
	return providers.map((p: Provider) => ({ id: p.name, label: p.label }));
}
