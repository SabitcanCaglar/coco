# LangGraph Control Plane

This service is the canonical Python control plane for mission and thread state.

Current scope:
- mission persistence
- append-only mission events
- mission steps and checkpoints
- persisted thread messages
- repo execution profiles
- mission command handling
- worker heartbeat/result endpoints

It supports Postgres for production and SQLite fallback for local development.

## Run

```bash
python3 services/langgraph_control_plane/app.py
```

Environment variables:
- `LANGGRAPH_CONTROL_PORT` default `4100`
- `LANGGRAPH_CONTROL_DATABASE_URL` enables Postgres mode
- `LANGGRAPH_CONTROL_DB` default `./.runtime/langgraph-control-plane.sqlite3`
