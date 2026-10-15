# Catalogue des modèles LLM

## Source de vérité

`apps/backend/models_registry.py` définit le catalogue livré avec WorkPilot : des
identifiants d'API vérifiés sur la liste officielle de chaque provider (la date est
dans chaque section). `provider_catalog()` alimente le fallback de l'API et le fichier
frontend généré `apps/frontend/src/shared/constants/model-catalog.generated.json`.
Ne pas ajouter de listes de modèles dans les composants.

Les prix n'y sont pas : `apps/backend/cost_intelligence/catalog.py` les tient, relevés
sur la page de prix officielle de chaque provider. Le plafond par session, les
estimations (`cost_intelligence/`, `scheduling/cost_estimator.py`) et les aperçus de
coût du renderer (`model-pricing.generated.json`, lu par
`renderer/lib/model-pricing.ts`) lisent tous ce catalogue.
`tests/cost_intelligence/test_catalog.py` vérifie que chaque modèle du registre y a un
prix, ou une raison écrite de n'en pas avoir.

Après une modification du registre ou des prix :

```sh
python scripts/generate_model_catalog.py
python scripts/generate_model_catalog.py --check
```

Les tests `tests/test_model_catalog_releases.py` (modèles) et
`tests/cost_intelligence/test_catalog.py` (prix) vérifient que les deux côtés restent
identiques.
Les anciens identifiants restent valides : une mise à jour du catalogue ne change pas
le modèle enregistré dans une tâche.

## Découverte et rafraîchissement

Les sélecteurs utilisent `useProviderModelCatalog(provider)`, un magasin partagé par
provider : une seule requête en cours, un même snapshot pour tous les écrans,
rafraîchissement manuel propagé et revalidation au retour sur la fenêtre.
Les catalogues locaux sont revalidés toutes les 30 secondes lorsqu'ils sont affichés.
Les catalogues distants sont revalidés toutes les 15 minutes ; le backend consulte
les APIs distantes au plus toutes les 6 heures, sauf rafraîchissement explicite.
Les téléchargements et suppressions invalident les catalogues locaux ouverts.

Le backend interroge les APIs de modèles Anthropic, OpenAI, Google, Mistral,
DeepSeek et xAI avec les identifiants configurés. Les filtres de génération ne sont
pas limités à GPT-5 ou Claude 4 ; les nouvelles versions listées par ces APIs sont
intégrées sans modifier le frontend. Anthropic et Google sont paginés.
Les catalogues locaux proviennent du serveur concerné ; une suggestion du registre
n'est jamais marquée comme installée. Un serveur inaccessible ne produit pas un
faux inventaire en cache.

Un provider sans API de découverte prise en charge (par exemple Windsurf ou Copilot),
ou sans authentification utilisable, conserve le fallback du registre. Il faut alors
mettre à jour ce registre : WorkPilot ne peut pas garantir une découverte automatique
que le provider n'expose pas. Une présence au catalogue ne garantit pas les droits du compte.

Les interfaces spécialisées de téléchargement (Ollama, Hugging Face), de saisie des
identifiants d'un endpoint personnalisé et d'audit hors ligne gardent leurs informations
propres (taille, fichiers, embeddings, validation des endpoints loopback). Elles ne sont
pas des catalogues statiques concurrents pour la sélection des modèles d'exécution.
