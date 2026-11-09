---
section: ✨ Nouveautés
---

- **Le détecteur de dérive lit les commentaires de doc, les exemples et l'historique git** (F196). Sur toutes les stacks et sans modèle, il signale un commentaire de doc qui nomme un paramètre que le code ne prend plus (`@param`, `<param>`, docstrings Google, NumPy, Sphinx, rustdoc, Swift…), un exemple de code qui ne se lit pas, importe ce que le projet n'a plus ou appelle une fonction avec des arguments qu'elle n'accepte plus, et un document dont le code a changé depuis son dernier commit. Chaque document reçoit un score de fraîcheur, les traductions sont vérifiées chacune de leur côté, et `<!-- no-drift-check -->` exclut ce qui décrit une autre version. Les dérives simples (paramètre renommé, type de docstring, fichier déplacé) se corrigent en un clic sur une carte de revue, le rapport s'exporte en JSON ou HTML, et une porte QA (`WORKPILOT_QA_DOC_DRIFT`) comme `python -m doc_drift_detector check` signalent la dérive d'une branche (#354).
