---
section: 🐛 Corrections
---

- **Détecteur d'anomalies CI/CD sur toutes les stacks, sans faux positifs** : il reconnaît
  maintenant les échecs de NuGet/.NET (NU1605, NU1101, NU1301, test host planté), Maven, Gradle,
  Cargo, Composer, pub (Flutter), Go, pip, Bundler, SwiftPM, Docker Hub et des runners GitHub
  Actions, et non plus npm et la JVM seuls. « Changed », « Exchange » ou « tests 401 à 420 »
  ne déclenchent plus de délai dépassé ni d'échec d'authentification. Chaque correctif a un
  identifiant et s'affiche dans la langue de l'app ; on peut coller plusieurs builds pour voir
  les échecs qui reviennent, et les correctifs suggérés s'affichent enfin.
