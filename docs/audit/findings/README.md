# Constats d'audit, un fichier chacun

Depuis F113, chaque constat de [`AUDIT-NETTOYAGE.md`](../AUDIT-NETTOYAGE.md) vit ici. Deux PR qui
ajoutent chacune un constat touchent deux fichiers différents, au lieu de la même fin de cahier et
de la même fin de tableau dans l'atlas.

| Fichier | Rôle |
|---|---|
| `F<n>.md` | le constat détaillé, avec en tête (frontmatter) les champs de sa carte dans l'atlas |
| `F<n>.js` | la carte que [`WorkPilot-architecture.html`](../WorkPilot-architecture.html) charge ; **généré**, ne pas éditer |

## Ajouter un constat

1. Prendre le numéro suivant le plus grand de ce dossier. L'atlas lit `F113.js`, `F114.js`… dans
   l'ordre et s'arrête après trois numéros manquants de suite : pas de trou de trois.
2. Écrire `F<n>.md` sur le modèle d'un constat existant :

   ```markdown
   ---
   id: F125
   title: Ce qui n'allait pas, en une phrase
   severity: moy          # crit | haute | moy | basse
   status: résolu         # nouveau | aggravé | ouvert | partiel | atténué | résolu
   category: frontend     # le filtre « catégorie » de l'atlas
   verified: vérifié
   card:                  # la carte de l'atlas ; HTML court permis (<b>, <code>)
     finding: >-
       <b>Corrigé par le lot N…</b>. Ce qui se passait et ce qui change.
     evidence: >-
       les fichiers, séparés par « · »
     recommendation: >-
       ce qui reste à faire, ou « Fait. »
     gain: >-
       ce que l'utilisateur y gagne
     preserve: >-
       les features à ne pas casser
   ---

   # F125 · Ce qui n'allait pas, en une phrase

   - **Sévérité** moyenne · **trouvé par …** · **corrigé par …**
   - **Preuve** (avant) : …
   - **Correction** : …
   - **Garde-fou** : le test qui le tient.
   ```

   Les champs de la carte s'écrivent en bloc `>-` : un « : » au milieu d'une valeur simple
   n'est pas du YAML valide.
3. `python scripts/audit_findings.py build` écrit `F<n>.js`. `tests/test_audit_findings.py`
   (donc la CI) échoue si un `.js` manque, n'est plus à jour ou si l'en-tête est invalide.

Un constat de sécurité n'est décrit ici qu'une fois corrigé : voir [`SECURITY.md`](../../SECURITY.md).
