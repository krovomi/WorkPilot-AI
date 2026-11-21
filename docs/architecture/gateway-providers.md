---
feature: Passerelles de modèles (OpenRouter, Hugging Face)
summary: >-
  OpenRouter et Hugging Face Inference Providers sont deux providers à part entière, menés par le
  client compatible OpenAI : une clé, des centaines de modèles, liste en direct sans clé limitée
  aux modèles qui appellent des outils, prix et fenêtre lus chez la passerelle, effort par
  `reasoning.effort`, clé testée sur le compte et jamais sur la liste.
---

# Passerelles de modèles : OpenRouter et Hugging Face

Une passerelle sert les modèles de nombreux éditeurs derrière une seule API compatible OpenAI et
une seule clé. Deux sont branchées :

| Provider | Point d'entrée | Clé | Facture |
|---|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | clé OpenRouter (`OPENROUTER_API_KEY`) | compte OpenRouter |
| `huggingface` | `https://router.huggingface.co/v1` | jeton fin « Make calls to Inference Providers » (`HUGGINGFACE_API_KEY`, sinon `HF_TOKEN`) | compte Hugging Face, au prix du fournisseur, sans marge |

Depuis le 16 novembre 2026, le routeur de chat de Hugging Face est servi par OpenRouter
([docs HF](https://huggingface.co/docs/inference-providers)). Les deux restent des providers
distincts : la clé, la facture et le catalogue (les modèles qui ont une page sur le Hub) ne sont
pas les mêmes, et un abonné HF PRO a des crédits mensuels que seule la clé HF consomme.

## Ce qui est partagé avec Mistral, DeepSeek et Grok

Le client est `CompatibleProviderAgentClient` (`core/agent_clients/compatible.py`) : outils
déclarés par type d'agent, sous-agents émulés, serveurs MCP pontés, `AGENTS.md` injecté, compaction
émulée. Rien de propre aux passerelles n'est ajouté à la boucle ; les faits propres vivent dans
`apps/backend/gateway_providers.py` (une feuille, qui n'importe rien du backend) et, côté Electron,
dans `src/shared/constants/gateway-providers.ts`.

## Choix

- **Liste en direct, sans clé.** Les deux `/models` répondent sans clé ; la clé est envoyée quand
  elle existe. La liste ne garde que les modèles qui appellent des outils (`supported_parameters`
  contient `tools` chez OpenRouter ; un fournisseur `live` avec `supports_tools` chez Hugging Face) :
  une phase d'agent ne tourne pas sans. Chaque modèle porte son prix (USD par million de jetons ;
  chez Hugging Face, celui du fournisseur le moins cher qui appelle des outils), sa fenêtre de
  contexte et un palier estimé sur le prix (trois jetons d'entrée pour un de sortie).
- **La clé se teste sur le compte.** `/models` acceptant n'importe quelle clé, un test dessus dirait
  oui à tout : la clé OpenRouter se vérifie sur `/api/v1/key`, le jeton HF sur `/api/whoami-v2`, des
  URL constantes, jamais une URL reçue du renderer.
- **Effort.** OpenRouter reçoit `reasoning: {effort}` (`xhigh` pour ultrathink) et le traduit pour
  chaque modèle ; Hugging Face reçoit `reasoning_effort`. « none » n'envoie rien (un modèle dont le
  raisonnement est obligatoire le refuserait) ; un refus est rejoué sans le champ
  (`effort_was_rejected`).
- **Attribution OpenRouter.** Les en-têtes `HTTP-Referer` et `X-OpenRouter-Title` nomment l'app sur
  la page d'activité de l'utilisateur ; rien de la tâche n'y figure.
- **Valeurs par défaut.** `models_registry.py` donne un modèle par défaut à chaque passerelle et un
  repli hors ligne ; `cost_intelligence/catalog.py` les chiffre (relevé du 21 novembre 2026).
- **Hors-ligne strict.** Ce sont des providers cloud : `offline_policy` les refuse comme les autres.

## Où les toucher

| Besoin | Fichier |
|---|---|
| URL, clé, liste de modèles | `apps/backend/gateway_providers.py` |
| Client d'agent et appels courts | `core/client.py` (`_COMPATIBLE_PROVIDER_URLS`), `core/oneshot.py` |
| Effort, attribution | `core/llm_optimization.py` (`gateway_effort_params`, `compatible_cache_routing`) |
| Test de clé (API locale) | `provider_api.py` (`_VALIDATION_SPECS`) |
| Réglages, environnement du backend, test de clé (Electron) | `src/shared/constants/gateway-providers.ts`, `src/main/services/provider-settings-keys.ts` |
