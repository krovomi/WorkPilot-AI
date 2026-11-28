---
section: ✨ Nouveautés
---

- **Basculement entre plusieurs comptes d'un même provider** : chaque compte de Réglages → Comptes
  IA (OpenAI, Google, Mistral, DeepSeek, Grok, Meta, OpenRouter, Hugging Face) est une entrée de la
  chaîne de basculement. Une tâche arrêtée par une limite (429), un quota ou un crédit épuisé (402)
  ou une clé refusée (401) reprend sur le compte suivant du même provider, dans l'ordre de la
  chaîne, avant d'essayer un autre provider (interrupteur « D'abord les autres comptes du même
  provider »). Seule la tâche arrêtée change de compte : le compte par défaut des autres reste le
  même, et le compte quitté est mis de côté une heure (six après une clé refusée).
