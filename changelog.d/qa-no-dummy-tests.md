---
section: 🐛 Corrections
---

- **Une tâche qui ne change aucun code ne se retrouve plus avec de faux projets de tests.** Quand git ne voyait aucun fichier modifié (par exemple `tutu.txt` déjà présent sur la branche de base), la QA passait en revue complète et la barrière de couverture à 100 % faisait inventer au correcteur des projets de tests factices (`DummyTest.cs`, `TESTING.md`). Un changement vide passe maintenant en revue légère, qui vérifie que le dépôt remplit la spec, et la barrière de couverture ne s'applique plus qu'aux changements qui touchent du code.
