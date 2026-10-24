#!/bin/sh
# Starts the multi-user server: migrations, then the streaming WebSocket and
# the API. A failed migration stops the container instead of serving an API
# against a schema it does not match (fail closed, docs/rules/security.md S5).
set -eu

alembic -c server/db/alembic.ini upgrade head

python websocket_server.py &
ws_pid=$!

# Inside the container 0.0.0.0 is the container's own interface: what reaches
# it is decided by the published ports and the reverse proxy in front.
python -m uvicorn provider_api:app --host 0.0.0.0 --port 9000 &
api_pid=$!

# Either process exiting ends the container, so the orchestrator restarts a
# whole server rather than leaving half of one running.
trap 'kill "$ws_pid" "$api_pid" 2>/dev/null || true' INT TERM
while kill -0 "$ws_pid" 2>/dev/null && kill -0 "$api_pid" 2>/dev/null; do
  sleep 2
done
kill "$ws_pid" "$api_pid" 2>/dev/null || true
wait || true
exit 1
