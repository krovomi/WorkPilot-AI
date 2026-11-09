---
section: 🐛 Corrections
---

- **Import Design et le journal des modifications écrivent sur une branche de revue** (F180).
  « Écrire dans le projet » d'Import Design et « Enregistrer » du journal écrivaient dans le
  dossier du projet, sur la branche courante. Les fichiers du composant, `CHANGELOG.md` et les
  images collées vont maintenant sur la branche d'une carte « Code généré » en Revue humaine :
  vous relisez le diff, puis « Créer la PR ». Le chemin du journal ne peut plus sortir du projet.
