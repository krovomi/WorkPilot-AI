---
section: 🧪 Filets de test
---

- **Tests backend** : le test du bac à sable de l'agent de spec ne dépend plus de la façon dont pytest est lancé ; il échouait sous le script `pytest` d'un venv (interpréteur `python3.12`), donc dans le hook de commit des fusions.
