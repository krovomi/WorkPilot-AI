---
section: 🐛 Corrections
---

- **Visuel vers Code relie toutes les architectures cohérentes** (F160) : Backend → Worker, Worker → base de données, push temps réel vers les clients, webhooks, CDC, monitoring depuis n'importe quel bloc… La relation se choisit dans une liste adaptée aux deux blocs et à leurs stacks (gRPC, SignalR, MassTransit, EF Core, AMQP, FCM / APNs…) ou se saisit librement, et une connexion imprévue peut être forcée avec « Relier quand même ».
