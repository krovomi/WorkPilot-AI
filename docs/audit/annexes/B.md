# Annexe B — Ce qui a changé depuis l'audit précédent (`7057b28` → `b46a031`)

| PR | Changement | Effet sur les constats |
|---|---|---|
| #288, #289 | Installation / mise à jour de Codex CLI par le bon gestionnaire de paquets | aucun |
| #290 | Chaque tâche possède son moteur (provider × LLM × effort, par phase) | F4 inchangé (provider oui, agent_type non) ; F13 partiel ; **F25** nouveau (marqueur sans écrivain) |
| #291 | ui-ux-pro-max sur les tâches UI uniquement | F14 aggravé (4e écriture) ; **F27**, **F35** nouveaux ; `narrow_to_forecast` réduit les phases conditionnelles sur les tâches backend (gain) |
| #292 | Boucle `/verify` pour tous les providers | F2 partiellement corrigé ; F11 aggravé ; F16 étendu ; F23 aggravé (+370 lignes de doc) |

Statut des constats de l'audit précédent : F1, F3, F4, F5, F7, F8, F9, F10, F12, F16, F17, F19 **ouverts** ;
F2, F13 **partiels** ; F6, F11, F14, F18 **aggravés** ; F15 **atténué**. Nouveaux : F20 à F36.
Depuis : F1 et F24 corrigés (L1), F20 (L2), F21 et F22 (L3), F2, F3, F15, F35 et F38 (L6), F4, F5, F9 et F16 (L5), F6, F7, F14 et F34 (L7), F10, F11 et F17 (L10), F39 et F40 (L15), F41 à F47 (L16) ; F37 trouvé pendant L3, F38 pendant L6, F39 et F40 pendant L5, F41 à F45 pendant L15, F46 à F48 pendant L16 ; F52 à F56 relevés par l'audit du 17 octobre et corrigés par M1, F57 à F62 par M2, F63 à F68 par M3, F69 à F71 par M4, F78 à F84 par M5, F85 à F90 par M6, F91 à F94 par M7, F95 à F100 par M8, F72 à F77 par M9, F101 à F106 par M10, F107 à F112 par M11 (annexe F) ; F113 (CodeQL de la release 1.3.1) par #531 ; F114 (démarrage du main, 1.3.1) par #536 ; F115 (pages du wiki écrites à la main) par le mécanisme `scripts/wiki/patches/` ; F116 (boucle de reconnexion Claude sous Linux) par #543 ; F117 (releases en squash vers `main`) par #549 et la PR des commits de merge vers `main` ; lecture du marqueur F25 retirée et F118 (annonce Discord sans webhook) par le lot N1 du plan du 29 octobre ; F119 à F121 (planchers de couverture, démarrage de l'app, actions par SHA) par le lot N2 ; F122 (initialisation d'un projet existant) et F123 (specs E2E qui ne vérifiaient rien) par le lot N3. À partir de F113, chaque constat dit lui-même ce qui l'a corrigé, dans son fichier de [`findings/`](../findings/) : cette ligne ne s'allonge plus.

---

[Cahier de nettoyage](../AUDIT-NETTOYAGE.md)
