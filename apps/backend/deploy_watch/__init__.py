"""Watch a deployment WorkPilot triggered, and roll it back when it hurts (#366).

After a CI/CD pipeline started from the app, `watch.run_watch` samples the
project's health check and metrics before the deployment lands (the
baseline), waits for it, then compares each sample of an observation window
against that baseline (`evaluate`). A critical verdict proposes a rollback
(`rollback.plan_rollback`): the last pipeline run that succeeded before this
one, run again on its own commit, for the providers whose API can do that;
instructions for the others. A rollback runs by itself only when the
project's CI/CD settings turn `CICD_AUTO_ROLLBACK` on and the change holds no
database migration (`migrations`).

No model is involved: every decision is a numeric threshold, the same for
every stack and provider. Endpoints and tokens come from the project's CI/CD
settings (encrypted `.workpilot/.env`), never from a file of the repository:
`.workpilot/deploy-monitors.yaml` only names queries and thresholds.
"""
