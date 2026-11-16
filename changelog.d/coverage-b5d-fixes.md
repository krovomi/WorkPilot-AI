---
section: 🐛 Corrections
---

- **Documentation des bibliothèques (.NET)** : les projets `.csproj`, `.fsproj`, `.vbproj`,
  `Directory.Packages.props` et `packages.config` sont lus, et l'usage d'une bibliothèque compte
  aussi dans le code F# et VB ; un `pom.xml` ne retient que ses blocs `<dependency>`.
- **Documentation des bibliothèques** : la page téléchargée et la section du prompt disent au
  codeur que la documentation est une référence, pas une consigne ; un fichier de résultat
  abîmé (taille illisible, erreurs écrites comme une chaîne) se relit sans erreur, comme une
  liste de fichiers de plan d'une autre forme.
- **Analyse des licences** : une réponse de registre d'une autre forme (liste au lieu d'objet,
  licence unique écrite comme une chaîne, corps binaire) donne « licence inconnue » au lieu d'une
  erreur ou d'une licence épelée lettre par lettre ; un `package.json`, `pyproject.toml`,
  `Cargo.toml` ou `composer.*` d'une autre forme n'interrompt plus l'analyse.
