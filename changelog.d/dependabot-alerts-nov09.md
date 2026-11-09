---
section: 🔒 Sécurité
---

- **Les dernières alertes de dépendances sont corrigées.** oauthlib passe en 4.0.1 (CVE-2026-49272) côté Python ; glob et minimatch passent sur leurs versions corrigées (14.0.2+ et 11.0.1+) dans l'application de bureau et l'application mobile ; le renderer archify embarqué ne déclare plus fast-uri 3.1.5, et le script de vendoring garde ce plancher quand on le relance. Reste deepmerge (faible, outillage Jest du mobile) : aucune version corrigée n'existe encore.
