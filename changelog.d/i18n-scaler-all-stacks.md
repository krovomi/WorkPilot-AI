---
section: 🐛 Corrections
---

- **Rapport i18n sur les catalogues de toutes les stacks** : la couverture et les clés
  manquantes par langue se calculent aussi pour .NET (RESX), Android (`strings.xml`), iOS
  (`.strings`), gettext (`.po`), Flutter (ARB), Angular (XLIFF), Java/Kotlin (`.properties`),
  Rails (YAML) et Laravel (`lang/`), et non plus l'i18next JSON seul ; « Analyser tout le
  projet ouvert » lit le projet entier, et le rapport nomme les formats lus. gettext et Laravel
  donnent maintenant le texte traduit et pas seulement la clé, ce qui sert aussi à l'agent i18n.
  L'éditeur reste limité au JSON et le dit.
