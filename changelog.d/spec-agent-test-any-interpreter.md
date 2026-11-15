---
section: 🧪 Filets de test
---

- **Tests backend lancés par le script `pytest`** : trois tests qui exécutent l'interpréteur courant comme commande (bac à sable de l'agent de spec, commandes locales, délégation de bout en bout) le nomment `python`, le nom que l'allowlist connaît (`tests/allowlisted_python.py`). Sous le script `pytest` d'un venv, l'interpréteur s'appelle `python3.12` : ils n'y passaient pas, le hook de commit des fusions compris.
