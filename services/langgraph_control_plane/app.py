from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from uuid import uuid4

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - sqlite-only local environments
    psycopg = None
    dict_row = None


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def add_seconds(timestamp: str, seconds: int) -> str:
    return (datetime.fromisoformat(timestamp) + timedelta(seconds=seconds)).isoformat()


def normalize_text(value: str) -> list[str]:
    return "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in value.lower()).split()


def normalize_phrase(value: str) -> str:
    return " ".join(normalize_text(value))


def separator_variants(value: str) -> list[str]:
    normalized = normalize_phrase(value)
    if not normalized:
        return []
    compact = normalized.replace(" ", "")
    dashed = normalized.replace(" ", "-")
    underscored = normalized.replace(" ", "_")
    tokens = normalized.split()
    phrases: list[str] = []
    for size in range(2, min(len(tokens), 3) + 1):
        for index in range(len(tokens) - size + 1):
            phrases.append(" ".join(tokens[index : index + size]))
    variants = [normalized, compact, dashed, underscored]
    for phrase in phrases:
        phrase_compact = phrase.replace(" ", "")
        variants.extend(
            [phrase, phrase.replace(" ", "-"), phrase.replace(" ", "_"), phrase_compact]
        )
    return list(dict.fromkeys(variants))


def adjacent_swap_variants(value: str) -> list[str]:
    variants = {value}
    for index in range(len(value) - 1):
        chars = list(value)
        chars[index], chars[index + 1] = chars[index + 1], chars[index]
        variants.add("".join(chars))
    return list(variants)


GENERIC_REPO_ALIASES = {
    "old",
    "app",
    "apps",
    "project",
    "projects",
    "proje",
    "projeler",
    "workspace",
    "workspaces",
    "llm friendly",
    "llmfriendly",
}


def should_consider_repo_alias(alias: str) -> bool:
    normalized = normalize_phrase(alias)
    compact = normalized.replace(" ", "")
    if not normalized or normalized in GENERIC_REPO_ALIASES or compact in GENERIC_REPO_ALIASES:
        return False
    token_count = len(normalized.split())
    if token_count == 1 and len(compact) < 6:
        return False
    return True


def alias_matches_goal(alias: str, normalized_goal: str, compact_goal: str) -> bool:
    normalized_alias = normalize_phrase(alias)
    if not should_consider_repo_alias(normalized_alias):
        return False
    compact_alias = normalized_alias.replace(" ", "")
    if normalized_alias and normalized_alias in normalized_goal:
        return True
    return len(compact_alias) >= 6 and any(
        variant in compact_goal for variant in adjacent_swap_variants(compact_alias)
    )


def http_json(url: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    request = Request(
        url,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
        headers={"content-type": "application/json"} if body is not None else {},
    )
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


DATABASE_URL = os.environ.get("LANGGRAPH_CONTROL_DATABASE_URL", "").strip()
DB_PATH = Path(os.environ.get("LANGGRAPH_CONTROL_DB", "./.runtime/langgraph-control-plane.sqlite3"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
DATABASE_KIND = "postgres" if DATABASE_URL else "sqlite"
ORCHESTRATOR_URL = os.environ.get(
    "COCO_ORCHESTRATOR_URL",
    "http://orchestrator:3000" if Path("/.dockerenv").exists() else "http://127.0.0.1:3000",
).rstrip("/")
DISPATCH_INTERVAL_SECONDS = float(os.environ.get("COCO_MISSION_DISPATCH_INTERVAL", "2"))
DEFAULT_LOOP_PROVIDER = os.environ.get("COCO_MISSION_PROVIDER") or (
    "openclaw" if os.environ.get("OPENROUTER_API_KEY") else ""
)
DEFAULT_LOOP_MODEL = os.environ.get("COCO_OPENROUTER_MODEL", "").strip()


@dataclass(frozen=True)
class MissionCommandResult:
    mission: dict[str, Any]
    event: dict[str, Any]
    duplicate: bool = False


def sqlite_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def default_autonomy_policy() -> dict[str, Any]:
    return {
        "mode": "mixed-auto",
        "retryIntervalSeconds": 120,
        "maxAutoRetriesPerStep": 3,
        "enableWebResearch": True,
        "pauseOnRepeatedFailure": True,
    }


def row_to_mission(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "missionId": row["mission_id"],
        "tenantId": row["tenant_id"],
        "workspaceId": row["workspace_id"],
        "userId": row["user_id"],
        "threadId": row["thread_id"],
        "status": row["status"],
        "goal": row["goal"],
        "activeRepos": json.loads(row["active_repos_json"]),
        "priority": row["priority"],
        "createdBySurface": row["created_by_surface"],
        "approvalMode": row["approval_mode"],
        "autonomyPolicy": json.loads(row["autonomy_policy_json"]),
        "assignedWorkerSet": json.loads(row["assigned_worker_set_json"]),
        "currentPhase": row["current_phase"],
        "checkpointSummary": row["checkpoint_summary"],
        "blockedReason": row["blocked_reason"],
        "lastHumanInputAt": row["last_human_input_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "version": row["version"],
    }


def row_to_event(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "eventId": row["event_id"],
        "missionId": row["mission_id"],
        "eventType": row["event_type"],
        "surface": row["surface"],
        "causationId": row["causation_id"],
        "correlationId": row["correlation_id"],
        "idempotencyKey": row["idempotency_key"],
        "entityVersion": row["entity_version"],
        "createdAt": row["created_at"],
        "payload": json.loads(row["payload_json"]),
    }


def row_to_thread_message(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["message_id"],
        "threadId": row["thread_id"],
        "missionId": row["mission_id"],
        "role": row["role"],
        "text": row["text"],
        "surface": row["surface"],
        "createdAt": row["created_at"],
    }


class BaseStore:
    def init_db(self) -> None:
        raise NotImplementedError

    @contextmanager
    def tx(self) -> Iterator[Any]:
        raise NotImplementedError

    def list_missions(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_mission(self, mission_id: str) -> dict[str, Any] | None:
        raise NotImplementedError

    def get_thread_messages(self, thread_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_mission_events(self, mission_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    def append_thread_message(
        self,
        thread_id: str,
        role: str,
        text: str,
        surface: str,
        mission_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def create_mission(self, body: dict[str, Any]) -> MissionCommandResult:
        raise NotImplementedError

    def apply_command(self, mission_id: str, body: dict[str, Any]) -> MissionCommandResult:
        raise NotImplementedError

    def list_checkpoints(self, mission_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    def list_steps(self, mission_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    def attach_repo_execution_profile(self, repo_id: str, body: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def list_repo_execution_profiles(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_repo_execution_profile(self, repo_id: str) -> dict[str, Any] | None:
        raise NotImplementedError

    def list_approvals(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def record_worker_heartbeat(self, worker_id: str, body: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def accept_worker_result(self, worker_id: str, body: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class SQLiteStore(BaseStore):
    def __init__(self, path: Path):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init_db(self) -> None:
        with self.tx() as conn:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS missions (
                  mission_id TEXT PRIMARY KEY,
                  tenant_id TEXT,
                  workspace_id TEXT,
                  user_id TEXT NOT NULL,
                  thread_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  goal TEXT NOT NULL,
                  active_repos_json TEXT NOT NULL,
                  priority INTEGER NOT NULL,
                  created_by_surface TEXT NOT NULL,
                  approval_mode TEXT NOT NULL,
                  autonomy_policy_json TEXT NOT NULL,
                  assigned_worker_set_json TEXT NOT NULL,
                  current_phase TEXT NOT NULL,
                  checkpoint_summary TEXT,
                  blocked_reason TEXT,
                  last_human_input_at TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  version INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_missions_thread ON missions(thread_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS mission_events (
                  event_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  event_type TEXT NOT NULL,
                  surface TEXT NOT NULL,
                  causation_id TEXT,
                  correlation_id TEXT,
                  idempotency_key TEXT NOT NULL,
                  entity_version INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  payload_json TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_events_idempotency
                  ON mission_events(mission_id, idempotency_key);

                CREATE TABLE IF NOT EXISTS mission_steps (
                  step_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  phase_id TEXT NOT NULL,
                  step_class TEXT NOT NULL,
                  status TEXT NOT NULL,
                  worker_id TEXT,
                  repo_id TEXT,
                  inputs_json TEXT NOT NULL,
                  outputs_json TEXT NOT NULL,
                  attempt_count INTEGER NOT NULL,
                  max_attempts INTEGER NOT NULL,
                  next_retry_at TEXT,
                  requires_approval INTEGER NOT NULL,
                  idempotency_key TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_mission_steps_mission ON mission_steps(mission_id, created_at ASC);

                CREATE TABLE IF NOT EXISTS mission_checkpoints (
                  checkpoint_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  summary TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS thread_messages (
                  message_id TEXT PRIMARY KEY,
                  thread_id TEXT NOT NULL,
                  mission_id TEXT,
                  role TEXT NOT NULL,
                  text TEXT NOT NULL,
                  surface TEXT NOT NULL,
                  idempotency_key TEXT,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, created_at ASC);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_idempotency
                  ON thread_messages(thread_id, role, idempotency_key);

                CREATE TABLE IF NOT EXISTS research_records (
                  research_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  query_bundle TEXT NOT NULL,
                  error_signature TEXT NOT NULL,
                  sources_json TEXT NOT NULL,
                  citations_json TEXT NOT NULL,
                  summary TEXT NOT NULL,
                  recommended_action TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS worker_leases (
                  worker_id TEXT PRIMARY KEY,
                  mission_id TEXT,
                  step_id TEXT,
                  status TEXT NOT NULL,
                  lease_expires_at TEXT,
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS repo_execution_profiles (
                  repo_id TEXT PRIMARY KEY,
                  root_path TEXT NOT NULL,
                  stack_family TEXT NOT NULL,
                  runner_type TEXT NOT NULL,
                  build_commands_json TEXT NOT NULL,
                  test_commands_json TEXT NOT NULL,
                  lint_commands_json TEXT NOT NULL,
                  artifact_paths_json TEXT NOT NULL,
                  sandbox_class TEXT NOT NULL,
                  timeout_profile_json TEXT NOT NULL,
                  allowed_tools_json TEXT NOT NULL,
                  worker_capabilities_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                """
            )

    def _row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def _fetchall(self, conn: sqlite3.Connection, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def _emit_event(
        self,
        conn: sqlite3.Connection,
        mission_id: str,
        event_type: str,
        surface: str,
        idempotency_key: str,
        entity_version: int,
        payload: dict[str, Any],
        causation_id: str | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        event = {
            "eventId": str(uuid4()),
            "missionId": mission_id,
            "eventType": event_type,
            "surface": surface,
            "causationId": causation_id,
            "correlationId": correlation_id,
            "idempotencyKey": idempotency_key,
            "entityVersion": entity_version,
            "createdAt": now(),
            "payload": payload,
        }
        conn.execute(
            """
            INSERT INTO mission_events (
              event_id, mission_id, event_type, surface, causation_id, correlation_id,
              idempotency_key, entity_version, created_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event["eventId"],
                mission_id,
                event_type,
                surface,
                causation_id,
                correlation_id,
                idempotency_key,
                entity_version,
                event["createdAt"],
                sqlite_json(payload),
            ),
        )
        return event

    def _insert_checkpoint(self, conn: sqlite3.Connection, mission_id: str, summary: str, payload: dict[str, Any]) -> None:
        conn.execute(
            """
            INSERT INTO mission_checkpoints (checkpoint_id, mission_id, summary, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (str(uuid4()), mission_id, summary, sqlite_json(payload), now()),
        )

    def _insert_mission_step(
        self,
        conn: sqlite3.Connection,
        mission_id: str,
        requested_step_classes: list[str],
        idempotency_key: str,
        approval_mode: str,
        repo_id: str | None = None,
        runner_type: str | None = None,
        repo_goal: str | None = None,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        step_class = requested_step_classes[0] if requested_step_classes else "analysis"
        requires_approval = 1 if approval_mode == "approval-heavy" else 0
        timestamp = now()
        conn.execute(
            """
            INSERT INTO mission_steps (
              step_id, mission_id, phase_id, step_class, status, worker_id, repo_id, inputs_json,
              outputs_json, attempt_count, max_attempts, next_retry_at, requires_approval,
              idempotency_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid4()),
                mission_id,
                "phase-intake",
                step_class,
                "blocked" if requires_approval else "queued",
                runner_type,
                repo_id,
                sqlite_json(
                    {
                        "requestedStepClasses": requested_step_classes,
                        "repoGoal": repo_goal,
                        "provider": provider,
                        "model": model,
                    }
                ),
                sqlite_json({}),
                0,
                3,
                add_seconds(timestamp, 120),
                requires_approval,
                idempotency_key,
                timestamp,
                timestamp,
            ),
        )

    def list_missions(self) -> list[dict[str, Any]]:
        with self.tx() as conn:
            return [row_to_mission(row) for row in self._fetchall(conn, "SELECT * FROM missions ORDER BY updated_at DESC")]

    def get_mission(self, mission_id: str) -> dict[str, Any] | None:
        with self.tx() as conn:
            row = self._row(conn.execute("SELECT * FROM missions WHERE mission_id = ?", (mission_id,)).fetchone())
            return row_to_mission(row) if row else None

    def get_thread_messages(self, thread_id: str) -> list[dict[str, Any]]:
        with self.tx() as conn:
            rows = self._fetchall(
                conn,
                "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC",
                (thread_id,),
            )
            return [row_to_thread_message(row) for row in rows]

    def get_mission_events(self, mission_id: str) -> list[dict[str, Any]]:
        with self.tx() as conn:
            rows = self._fetchall(
                conn,
                "SELECT * FROM mission_events WHERE mission_id = ? ORDER BY entity_version ASC, created_at ASC",
                (mission_id,),
            )
            return [row_to_event(row) for row in rows]

    def append_thread_message(
        self,
        thread_id: str,
        role: str,
        text: str,
        surface: str,
        mission_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        safe_key = idempotency_key or str(uuid4())
        with self.tx() as conn:
            existing = self._row(
                conn.execute(
                    "SELECT * FROM thread_messages WHERE thread_id = ? AND role = ? AND idempotency_key = ?",
                    (thread_id, role, safe_key),
                ).fetchone()
            )
            if existing:
                return row_to_thread_message(existing)
            message = {
                "id": str(uuid4()),
                "threadId": thread_id,
                "missionId": mission_id,
                "role": role,
                "text": text,
                "surface": surface,
                "createdAt": now(),
            }
            conn.execute(
                """
                INSERT INTO thread_messages (
                  message_id, thread_id, mission_id, role, text, surface, idempotency_key, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message["id"],
                    thread_id,
                    mission_id,
                    role,
                    text,
                    surface,
                    safe_key,
                    message["createdAt"],
                ),
            )
            return message

    def create_mission(self, body: dict[str, Any]) -> MissionCommandResult:
        safe_key = str(body.get("idempotency_key") or uuid4())
        correlation_id = str(body.get("surface_event_id") or uuid4())
        requested_step_classes = [
            str(value) for value in body.get("requested_step_classes", []) if isinstance(value, str)
        ]
        with self.tx() as conn:
            duplicate = self._row(
                conn.execute(
                    """
                    SELECT m.* FROM missions m
                    JOIN mission_events e ON e.mission_id = m.mission_id
                    WHERE e.idempotency_key = ? AND e.event_type = 'MissionCreated'
                    ORDER BY e.created_at DESC LIMIT 1
                    """,
                    (safe_key,),
                ).fetchone()
            )
            if duplicate:
                duplicate_event = self._row(
                    conn.execute(
                        """
                        SELECT * FROM mission_events
                        WHERE mission_id = ? AND idempotency_key = ?
                        ORDER BY created_at DESC LIMIT 1
                        """,
                        (duplicate["mission_id"], safe_key),
                    ).fetchone()
                )
                return MissionCommandResult(
                    mission=row_to_mission(duplicate),
                    event=row_to_event(duplicate_event) if duplicate_event else {},
                    duplicate=True,
                )

            mission_id = str(uuid4())
            created_at = now()
            requested_repo_intents = normalize_repo_intents(
                body.get("target_repos") if isinstance(body.get("target_repos"), list) else []
            )
            explicit_active_repos = normalize_repo_intents(
                body.get("active_repos") if isinstance(body.get("active_repos"), list) else []
            )
            resolved_profiles, missing_repo_intents = resolve_repo_targets(
                conn,
                requested_repo_intents or explicit_active_repos,
                str(body.get("goal") or ""),
            )
            active_repos = [profile["repoId"] for profile in resolved_profiles]
            assigned_worker_set = sorted(
                {str(profile["runnerType"]) for profile in resolved_profiles if profile.get("runnerType")}
            )
            approval_mode = str(body.get("approval_mode") or "mixed")
            if missing_repo_intents:
                initial_status = "blocked"
                current_phase = "blocked"
                blocked_reason = (
                    "Tum Mission Dur: su repo(lar) makinede bulunamadi: "
                    + ", ".join(missing_repo_intents)
                )
                checkpoint_summary = blocked_reason
            elif approval_mode == "approval-heavy":
                initial_status = "blocked"
                current_phase = "approval-required"
                blocked_reason = "Awaiting approval for high-risk step."
                checkpoint_summary = "Approval required before execution can continue."
            else:
                initial_status = "pending"
                current_phase = "intake"
                blocked_reason = None
                checkpoint_summary = None
            mission = {
                "missionId": mission_id,
                "tenantId": body.get("tenant_id"),
                "workspaceId": body.get("workspace_id"),
                "userId": str(body.get("user_id") or "unknown-user"),
                "threadId": str(body.get("thread_id") or mission_id),
                "status": initial_status,
                "goal": str(body.get("goal") or ""),
                "activeRepos": active_repos,
                "priority": int(body.get("priority") or 0),
                "createdBySurface": str(body.get("created_by_surface") or "api"),
                "approvalMode": approval_mode,
                "autonomyPolicy": body.get("autonomy_policy") or default_autonomy_policy(),
                "assignedWorkerSet": assigned_worker_set,
                "currentPhase": current_phase,
                "checkpointSummary": checkpoint_summary,
                "blockedReason": blocked_reason,
                "lastHumanInputAt": created_at,
                "createdAt": created_at,
                "updatedAt": created_at,
                "version": 1,
            }
            conn.execute(
                """
                INSERT INTO missions (
                  mission_id, tenant_id, workspace_id, user_id, thread_id, status, goal,
                  active_repos_json, priority, created_by_surface, approval_mode,
                  autonomy_policy_json, assigned_worker_set_json, current_phase,
                  checkpoint_summary, blocked_reason, last_human_input_at, created_at, updated_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mission["missionId"],
                    mission["tenantId"],
                    mission["workspaceId"],
                    mission["userId"],
                    mission["threadId"],
                    mission["status"],
                    mission["goal"],
                    sqlite_json(mission["activeRepos"]),
                    mission["priority"],
                    mission["createdBySurface"],
                    mission["approvalMode"],
                    sqlite_json(mission["autonomyPolicy"]),
                    sqlite_json(mission["assignedWorkerSet"]),
                    mission["currentPhase"],
                    mission["checkpointSummary"],
                    mission["blockedReason"],
                    mission["lastHumanInputAt"],
                    mission["createdAt"],
                    mission["updatedAt"],
                    mission["version"],
                ),
            )
            event = self._emit_event(
                conn,
                mission_id,
                "MissionCreated",
                mission["createdBySurface"],
                safe_key,
                mission["version"],
                {
                    "goal": mission["goal"],
                    "executionMode": body.get("execution_mode"),
                    "requestedStepClasses": requested_step_classes,
                    "targetRepos": requested_repo_intents or active_repos,
                    "resolvedRepos": active_repos,
                    "missingRepos": missing_repo_intents,
                    "assignedWorkerSet": assigned_worker_set,
                    "provider": body.get("provider"),
                    "model": body.get("model"),
                },
                correlation_id=correlation_id,
            )
            for profile in resolved_profiles:
                self._insert_mission_step(
                    conn,
                    mission_id,
                    requested_step_classes,
                    f"{safe_key}:{profile['repoId']}",
                    mission["approvalMode"] if not missing_repo_intents else "approval-heavy",
                    repo_id=profile["repoId"],
                    runner_type=profile["runnerType"],
                    repo_goal=derive_repo_goal_slice(mission["goal"], profile["repoId"]),
                    provider=str(body.get("provider")) if body.get("provider") else None,
                    model=str(body.get("model")) if body.get("model") else None,
                )
                self._emit_event(
                    conn,
                    mission_id,
                    "WorkerAssigned",
                    mission["createdBySurface"],
                    f"{safe_key}:worker-assigned:{profile['repoId']}",
                    mission["version"],
                    {
                        "repoId": profile["repoId"],
                        "runnerType": profile["runnerType"],
                        "stackFamily": profile["stackFamily"],
                    },
                    correlation_id=correlation_id,
                )
            self._insert_checkpoint(
                conn,
                mission_id,
                mission["checkpointSummary"] or "Mission created and queued for intake.",
                {
                    "phase": mission["currentPhase"],
                    "status": mission["status"],
                    "resolvedRepos": active_repos,
                    "missingRepos": missing_repo_intents,
                },
            )
            return MissionCommandResult(mission=mission, event=event, duplicate=False)

    def apply_command(self, mission_id: str, body: dict[str, Any]) -> MissionCommandResult:
        safe_key = str(body.get("idempotency_key") or uuid4())
        command = str(body.get("command") or "status")
        expected_version = body.get("expected_version")
        with self.tx() as conn:
            mission_row = self._row(
                conn.execute("SELECT * FROM missions WHERE mission_id = ?", (mission_id,)).fetchone()
            )
            if not mission_row:
                raise KeyError("Mission not found.")
            mission = row_to_mission(mission_row)
            duplicate_event = self._row(
                conn.execute(
                    """
                    SELECT * FROM mission_events
                    WHERE mission_id = ? AND idempotency_key = ?
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (mission_id, safe_key),
                ).fetchone()
            )
            if duplicate_event:
                return MissionCommandResult(
                    mission=mission,
                    event=row_to_event(duplicate_event),
                    duplicate=True,
                )
            if expected_version is not None and int(expected_version) != int(mission["version"]):
                raise ValueError("Mission version conflict.")

            next_status = mission["status"]
            event_type = "MissionUpdated"
            current_phase = mission["currentPhase"]
            blocked_reason = mission["blockedReason"]
            checkpoint_summary = mission["checkpointSummary"]

            if command == "pause":
                next_status = "paused"
                event_type = "MissionPaused"
                current_phase = "paused"
                checkpoint_summary = "Mission paused by operator."
            elif command == "resume":
                next_status = "running"
                event_type = "MissionResumed"
                current_phase = "dispatch"
                blocked_reason = None
                checkpoint_summary = "Mission resumed from last durable checkpoint."
            elif command == "cancel":
                next_status = "cancelled"
                event_type = "MissionCancelled"
                current_phase = "cancelled"
                checkpoint_summary = "Mission cancelled by operator."
            elif command == "status":
                event_type = "MissionUpdated"
            elif command == "approve":
                next_status = "running"
                event_type = "MissionUpdated"
                current_phase = "dispatch"
                blocked_reason = None
                checkpoint_summary = "Approval granted; mission resumed."
            elif command == "block":
                next_status = "blocked"
                event_type = "MissionBlocked"
                current_phase = "blocked"
                blocked_reason = str(body.get("blocked_reason") or "Blocked by operator.")
                checkpoint_summary = blocked_reason

            next_version = int(mission["version"]) + 1
            updated_at = now()
            conn.execute(
                """
                UPDATE missions
                SET status = ?, current_phase = ?, blocked_reason = ?, checkpoint_summary = ?,
                    updated_at = ?, version = ?, last_human_input_at = ?
                WHERE mission_id = ?
                """,
                (
                    next_status,
                    current_phase,
                    blocked_reason,
                    checkpoint_summary,
                    updated_at,
                    next_version,
                    updated_at,
                    mission_id,
                ),
            )
            event = self._emit_event(
                conn,
                mission_id,
                event_type,
                str(body.get("surface") or "api"),
                safe_key,
                next_version,
                {
                    "command": command,
                    "chatReply": body.get("chat_reply"),
                    "expectedVersion": expected_version,
                },
                correlation_id=str(body.get("surface_event_id") or uuid4()),
            )
            if checkpoint_summary:
                self._insert_checkpoint(
                    conn,
                    mission_id,
                    checkpoint_summary,
                    {"status": next_status, "currentPhase": current_phase, "command": command},
                )
            updated_row = self._row(
                conn.execute("SELECT * FROM missions WHERE mission_id = ?", (mission_id,)).fetchone()
            )
            return MissionCommandResult(
                mission=row_to_mission(updated_row),
                event=event,
                duplicate=False,
            )

    def list_checkpoints(self, mission_id: str) -> list[dict[str, Any]]:
        with self.tx() as conn:
            rows = self._fetchall(
                conn,
                "SELECT * FROM mission_checkpoints WHERE mission_id = ? ORDER BY created_at ASC",
                (mission_id,),
            )
            return [
                {
                    "checkpointId": row["checkpoint_id"],
                    "missionId": row["mission_id"],
                    "summary": row["summary"],
                    "payload": json.loads(row["payload_json"]),
                    "createdAt": row["created_at"],
                }
                for row in rows
            ]

    def list_steps(self, mission_id: str) -> list[dict[str, Any]]:
        with self.tx() as conn:
            rows = self._fetchall(
                conn,
                "SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY created_at ASC",
                (mission_id,),
            )
            return [
                {
                    "stepId": row["step_id"],
                    "missionId": row["mission_id"],
                    "phaseId": row["phase_id"],
                    "stepClass": row["step_class"],
                    "status": row["status"],
                    "workerId": row["worker_id"],
                    "repoId": row["repo_id"],
                    "inputs": json.loads(row["inputs_json"]),
                    "outputs": json.loads(row["outputs_json"]),
                    "attemptCount": row["attempt_count"],
                    "maxAttempts": row["max_attempts"],
                    "nextRetryAt": row["next_retry_at"],
                    "requiresApproval": bool(row["requires_approval"]),
                    "idempotencyKey": row["idempotency_key"],
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
                for row in rows
            ]

    def attach_repo_execution_profile(self, repo_id: str, body: dict[str, Any]) -> dict[str, Any]:
        profile = {
            "repoId": repo_id,
            "rootPath": str(body.get("root_path") or ""),
            "stackFamily": str(body.get("stack_family") or "mixed"),
            "runnerType": str(body.get("runner_type") or "generic-worker"),
            "buildCommands": body.get("build_commands") or [],
            "testCommands": body.get("test_commands") or [],
            "lintCommands": body.get("lint_commands") or [],
            "artifactPaths": body.get("artifact_paths") or [],
            "sandboxClass": str(body.get("sandbox_class") or "default"),
            "timeoutProfile": body.get("timeout_profile") or {},
            "allowedTools": body.get("allowed_tools") or [],
            "workerCapabilities": body.get("worker_capabilities")
            or {
                "can_edit_code": True,
                "can_run_tests": True,
                "can_build": True,
                "can_use_browser": False,
                "can_search_web": True,
                "can_run_shell": True,
                "can_open_ide": False,
                "artifact_paths": [],
                "timeout_limits": {},
                "sandbox_class": str(body.get("sandbox_class") or "default"),
            },
            "updatedAt": now(),
        }
        with self.tx() as conn:
            conn.execute(
                """
                INSERT INTO repo_execution_profiles (
                  repo_id, root_path, stack_family, runner_type, build_commands_json, test_commands_json,
                  lint_commands_json, artifact_paths_json, sandbox_class, timeout_profile_json,
                  allowed_tools_json, worker_capabilities_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo_id) DO UPDATE SET
                  root_path = excluded.root_path,
                  stack_family = excluded.stack_family,
                  runner_type = excluded.runner_type,
                  build_commands_json = excluded.build_commands_json,
                  test_commands_json = excluded.test_commands_json,
                  lint_commands_json = excluded.lint_commands_json,
                  artifact_paths_json = excluded.artifact_paths_json,
                  sandbox_class = excluded.sandbox_class,
                  timeout_profile_json = excluded.timeout_profile_json,
                  allowed_tools_json = excluded.allowed_tools_json,
                  worker_capabilities_json = excluded.worker_capabilities_json,
                  updated_at = excluded.updated_at
                """,
                (
                    profile["repoId"],
                    profile["rootPath"],
                    profile["stackFamily"],
                    profile["runnerType"],
                    sqlite_json(profile["buildCommands"]),
                    sqlite_json(profile["testCommands"]),
                    sqlite_json(profile["lintCommands"]),
                    sqlite_json(profile["artifactPaths"]),
                    profile["sandboxClass"],
                    sqlite_json(profile["timeoutProfile"]),
                    sqlite_json(profile["allowedTools"]),
                    sqlite_json(profile["workerCapabilities"]),
                    profile["updatedAt"],
                ),
            )
        return profile

    def list_repo_execution_profiles(self) -> list[dict[str, Any]]:
        with self.tx() as conn:
            rows = self._fetchall(conn, "SELECT * FROM repo_execution_profiles ORDER BY updated_at DESC")
            return [
                {
                    "repoId": row["repo_id"],
                    "rootPath": row["root_path"],
                    "stackFamily": row["stack_family"],
                    "runnerType": row["runner_type"],
                    "buildCommands": json.loads(row["build_commands_json"]),
                    "testCommands": json.loads(row["test_commands_json"]),
                    "lintCommands": json.loads(row["lint_commands_json"]),
                    "artifactPaths": json.loads(row["artifact_paths_json"]),
                    "sandboxClass": row["sandbox_class"],
                    "timeoutProfile": json.loads(row["timeout_profile_json"]),
                    "allowedTools": json.loads(row["allowed_tools_json"]),
                    "workerCapabilities": json.loads(row["worker_capabilities_json"]),
                    "updatedAt": row["updated_at"],
                }
                for row in rows
            ]

    def get_repo_execution_profile(self, repo_id: str) -> dict[str, Any] | None:
        with self.tx() as conn:
            row = self._row(
                conn.execute(
                    "SELECT * FROM repo_execution_profiles WHERE repo_id = ?",
                    (repo_id,),
                ).fetchone()
            )
            if not row:
                return None
            return {
                "repoId": row["repo_id"],
                "rootPath": row["root_path"],
                "stackFamily": row["stack_family"],
                "runnerType": row["runner_type"],
                "buildCommands": json.loads(row["build_commands_json"]),
                "testCommands": json.loads(row["test_commands_json"]),
                "lintCommands": json.loads(row["lint_commands_json"]),
                "artifactPaths": json.loads(row["artifact_paths_json"]),
                "sandboxClass": row["sandbox_class"],
                "timeoutProfile": json.loads(row["timeout_profile_json"]),
                "allowedTools": json.loads(row["allowed_tools_json"]),
                "workerCapabilities": json.loads(row["worker_capabilities_json"]),
                "updatedAt": row["updated_at"],
            }

    def list_approvals(self) -> list[dict[str, Any]]:
        with self.tx() as conn:
            rows = self._fetchall(
                conn,
                """
                SELECT
                  m.mission_id,
                  m.thread_id,
                  m.goal,
                  m.checkpoint_summary,
                  s.step_id,
                  s.step_class,
                  s.repo_id,
                  s.worker_id,
                  s.created_at
                FROM mission_steps s
                JOIN missions m ON m.mission_id = s.mission_id
                WHERE s.requires_approval = 1 AND s.status = 'blocked'
                ORDER BY s.created_at ASC
                """,
            )
            return [
                {
                    "missionId": row["mission_id"],
                    "stepId": row["step_id"],
                    "threadId": row["thread_id"],
                    "goal": row["goal"],
                    "stepClass": row["step_class"],
                    "repoId": row["repo_id"],
                    "runnerType": row["worker_id"],
                    "summary": row["checkpoint_summary"]
                    or "Approval required before execution can continue.",
                    "createdAt": row["created_at"],
                }
                for row in rows
            ]

    def record_worker_heartbeat(self, worker_id: str, body: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "workerId": worker_id,
            "missionId": body.get("mission_id"),
            "stepId": body.get("step_id"),
            "status": str(body.get("status") or "idle"),
            "leaseExpiresAt": str(body.get("lease_expires_at") or add_seconds(now(), 60)),
            "payload": body,
            "updatedAt": now(),
        }
        with self.tx() as conn:
            conn.execute(
                """
                INSERT INTO worker_leases (worker_id, mission_id, step_id, status, lease_expires_at, payload_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(worker_id) DO UPDATE SET
                  mission_id = excluded.mission_id,
                  step_id = excluded.step_id,
                  status = excluded.status,
                  lease_expires_at = excluded.lease_expires_at,
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (
                    payload["workerId"],
                    payload["missionId"],
                    payload["stepId"],
                    payload["status"],
                    payload["leaseExpiresAt"],
                    sqlite_json(payload["payload"]),
                    payload["updatedAt"],
                ),
            )
        return payload

    def accept_worker_result(self, worker_id: str, body: dict[str, Any]) -> dict[str, Any]:
        mission_id = str(body.get("mission_id") or "")
        step_id = str(body.get("step_id") or "")
        result_status = str(body.get("status") or "completed")
        safe_key = str(body.get("idempotency_key") or uuid4())
        with self.tx() as conn:
            if mission_id and step_id:
                conn.execute(
                    """
                    UPDATE mission_steps
                    SET status = ?, outputs_json = ?, attempt_count = attempt_count + 1, updated_at = ?, next_retry_at = ?
                    WHERE mission_id = ? AND step_id = ?
                    """,
                    (
                        result_status,
                        sqlite_json(body.get("outputs") or {}),
                        now(),
                        add_seconds(now(), 120) if result_status == "retryable" else None,
                        mission_id,
                        step_id,
                    ),
                )
                mission_row = self._row(
                    conn.execute("SELECT * FROM missions WHERE mission_id = ?", (mission_id,)).fetchone()
                )
                if mission_row:
                    mission = row_to_mission(mission_row)
                    step_rows = self._fetchall(
                        conn,
                        "SELECT status, repo_id FROM mission_steps WHERE mission_id = ? ORDER BY created_at ASC",
                        (mission_id,),
                    )
                    step_statuses = [str(row["status"]) for row in step_rows]
                    if step_statuses and all(status == "completed" for status in step_statuses):
                        next_status = "completed"
                        current_phase = "completed"
                        blocked_reason = None
                        checkpoint_summary = "Tum repo step'leri tamamlandi."
                    elif any(status in {"blocked", "failed"} for status in step_statuses):
                        next_status = "blocked"
                        current_phase = "blocked"
                        if result_status == "failed":
                            blocked_reason = str(
                                body.get("blocked_reason") or "Worker reported blocking failure."
                            )
                            checkpoint_summary = blocked_reason
                        else:
                            blocked_reason = mission["blockedReason"]
                            checkpoint_summary = mission["checkpointSummary"]
                    elif any(status in {"running", "queued", "retryable"} for status in step_statuses):
                        next_status = "running"
                        current_phase = "dispatch"
                        blocked_reason = None
                        checkpoint_summary = (
                            "Worker requested retry after transient failure."
                            if result_status == "retryable"
                            else "Mission step ilerliyor."
                        )
                    else:
                        next_status = mission["status"]
                        current_phase = mission["currentPhase"]
                        checkpoint_summary = mission["checkpointSummary"]
                        blocked_reason = mission["blockedReason"]
                    next_version = int(mission["version"]) + 1
                    conn.execute(
                        """
                        UPDATE missions
                        SET status = ?, current_phase = ?, checkpoint_summary = ?, blocked_reason = ?,
                            updated_at = ?, version = ?
                        WHERE mission_id = ?
                        """,
                        (
                            next_status,
                            current_phase,
                            checkpoint_summary,
                            blocked_reason,
                            now(),
                            next_version,
                            mission_id,
                        ),
                    )
                    event_type = (
                        "StepCompleted"
                        if result_status == "completed"
                        else "StepRetried"
                        if result_status == "retryable"
                        else "StepFailed"
                    )
                    self._emit_event(
                        conn,
                        mission_id,
                        event_type,
                        "worker",
                        safe_key,
                        next_version,
                        {
                            "workerId": worker_id,
                            "stepId": step_id,
                            "status": result_status,
                            "outputs": body.get("outputs") or {},
                        },
                    )
                    if checkpoint_summary:
                        self._insert_checkpoint(
                            conn,
                            mission_id,
                            checkpoint_summary,
                            {"stepId": step_id, "status": result_status},
                        )
            return {
                "ok": True,
                "workerId": worker_id,
                "accepted": True,
                "status": result_status,
            }


class PostgresStore(SQLiteStore):
    def __init__(self, database_url: str):
        if psycopg is None:
            raise RuntimeError("psycopg is required when LANGGRAPH_CONTROL_DATABASE_URL is set.")
        self.database_url = database_url

    class _CompatConnection:
        def __init__(self, conn):
            self._conn = conn

        @staticmethod
        def _normalize(query: str) -> str:
            return query.replace("?", "%s")

        def execute(self, query: str, params: tuple[Any, ...] = ()):
            return self._conn.execute(self._normalize(query), params)

    def connect(self):
        return psycopg.connect(self.database_url, row_factory=dict_row)

    @contextmanager
    def tx(self):
        conn = self.connect()
        try:
            with conn.transaction():
                yield self._CompatConnection(conn)
        finally:
            conn.close()

    def init_db(self) -> None:
        with self.tx() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS missions (
                  mission_id TEXT PRIMARY KEY,
                  tenant_id TEXT,
                  workspace_id TEXT,
                  user_id TEXT NOT NULL,
                  thread_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  goal TEXT NOT NULL,
                  active_repos_json TEXT NOT NULL,
                  priority INTEGER NOT NULL,
                  created_by_surface TEXT NOT NULL,
                  approval_mode TEXT NOT NULL,
                  autonomy_policy_json TEXT NOT NULL,
                  assigned_worker_set_json TEXT NOT NULL,
                  current_phase TEXT NOT NULL,
                  checkpoint_summary TEXT,
                  blocked_reason TEXT,
                  last_human_input_at TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  version INTEGER NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_missions_thread ON missions(thread_id, updated_at DESC)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS mission_events (
                  event_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  event_type TEXT NOT NULL,
                  surface TEXT NOT NULL,
                  causation_id TEXT,
                  correlation_id TEXT,
                  idempotency_key TEXT NOT NULL,
                  entity_version INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  payload_json TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_events_idempotency ON mission_events(mission_id, idempotency_key)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS mission_steps (
                  step_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  phase_id TEXT NOT NULL,
                  step_class TEXT NOT NULL,
                  status TEXT NOT NULL,
                  worker_id TEXT,
                  repo_id TEXT,
                  inputs_json TEXT NOT NULL,
                  outputs_json TEXT NOT NULL,
                  attempt_count INTEGER NOT NULL,
                  max_attempts INTEGER NOT NULL,
                  next_retry_at TEXT,
                  requires_approval INTEGER NOT NULL,
                  idempotency_key TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_mission_steps_mission ON mission_steps(mission_id, created_at ASC)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS mission_checkpoints (
                  checkpoint_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  summary TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS thread_messages (
                  message_id TEXT PRIMARY KEY,
                  thread_id TEXT NOT NULL,
                  mission_id TEXT,
                  role TEXT NOT NULL,
                  text TEXT NOT NULL,
                  surface TEXT NOT NULL,
                  idempotency_key TEXT,
                  created_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, created_at ASC)")
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_idempotency ON thread_messages(thread_id, role, idempotency_key)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS research_records (
                  research_id TEXT PRIMARY KEY,
                  mission_id TEXT NOT NULL,
                  query_bundle TEXT NOT NULL,
                  error_signature TEXT NOT NULL,
                  sources_json TEXT NOT NULL,
                  citations_json TEXT NOT NULL,
                  summary TEXT NOT NULL,
                  recommended_action TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS worker_leases (
                  worker_id TEXT PRIMARY KEY,
                  mission_id TEXT,
                  step_id TEXT,
                  status TEXT NOT NULL,
                  lease_expires_at TEXT,
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS repo_execution_profiles (
                  repo_id TEXT PRIMARY KEY,
                  root_path TEXT NOT NULL,
                  stack_family TEXT NOT NULL,
                  runner_type TEXT NOT NULL,
                  build_commands_json TEXT NOT NULL,
                  test_commands_json TEXT NOT NULL,
                  lint_commands_json TEXT NOT NULL,
                  artifact_paths_json TEXT NOT NULL,
                  sandbox_class TEXT NOT NULL,
                  timeout_profile_json TEXT NOT NULL,
                  allowed_tools_json TEXT NOT NULL,
                  worker_capabilities_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )

    def _row(self, row):
        return dict(row) if row else None

    def _fetchall(self, conn, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]


def create_store() -> BaseStore:
    if DATABASE_KIND == "postgres":
        return PostgresStore(DATABASE_URL)
    return SQLiteStore(DB_PATH)


STORE = create_store()


DISCOVERY_ROOTS = [
    Path("/Users/canfamily/Desktop"),
    Path("/Users/canfamily/Documents"),
    Path("/Users/canfamily/Projects"),
    Path("/Users/canfamily/Code"),
    Path("/Users/canfamily/Workspace"),
    Path("/host-home/Desktop"),
    Path("/host-home/Projects"),
]

for extra_root in os.environ.get("COCO_REPO_DISCOVERY_ROOTS", "").split(","):
    extra_root = extra_root.strip()
    if extra_root:
        DISCOVERY_ROOTS.append(Path(extra_root))


def normalize_repo_intents(values: list[Any]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        slug = normalize_phrase(value).replace(" ", "-")
        if slug and slug not in normalized:
            normalized.append(slug)
    return normalized


def infer_stack_family(root_path: str) -> str:
    path = Path(root_path)
    if any(path.glob("*.uproject")) or any(path.glob("Source/*.Target.cs")):
        return "cpp-unreal"
    if (path / "package.json").exists() or (path / "tsconfig.json").exists():
        return "ts"
    if any(path.glob("*.sln")) or any(path.glob("*.csproj")) or any(path.glob("src/*.csproj")):
        return "csharp"
    return "mixed"


def runner_for_stack(stack_family: str) -> str:
    return {
        "cpp-unreal": "unreal-cpp-worker",
        "csharp": "csharp-worker",
        "ts": "ts-worker",
    }.get(stack_family, "generic-worker")


def repo_aliases(root_path: str) -> list[str]:
    path = Path(root_path)
    aliases = set(separator_variants(path.name))
    for manifest_name in ("package.json",):
        manifest_path = path / manifest_name
        if manifest_path.exists():
            try:
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                name = payload.get("name")
                if isinstance(name, str) and name.strip():
                    aliases.update(separator_variants(name))
            except Exception:
                pass
    for pattern in ("*.sln", "*.uproject"):
        for candidate in path.glob(pattern):
            aliases.update(separator_variants(candidate.stem))
    return [alias for alias in aliases if should_consider_repo_alias(alias)]


def list_registered_repos() -> list[dict[str, Any]]:
    try:
        repos = http_json(f"{ORCHESTRATOR_URL}/repos")
    except Exception:
        return []
    return repos if isinstance(repos, list) else []


def ensure_repo_registered(root_path: str) -> dict[str, Any] | None:
    for repo in list_registered_repos():
        if str(repo.get("rootPath") or "") == root_path:
            return repo
    try:
        repo = http_json(f"{ORCHESTRATOR_URL}/repos", method="POST", body={"path": root_path})
    except Exception:
        return None
    return repo if isinstance(repo, dict) else None


def discover_repo_candidates() -> list[dict[str, Any]]:
    registered = list_registered_repos()
    discovered: list[dict[str, Any]] = []
    seen_paths = {str(repo.get("rootPath") or "") for repo in registered}
    for repo in registered:
        root_path = str(repo.get("rootPath") or "")
        if not root_path:
            continue
        discovered.append(
            {
                "repoId": str(repo.get("id") or ""),
                "rootPath": root_path,
                "aliases": repo_aliases(root_path),
                "stackFamily": infer_stack_family(root_path),
                "confidence": 1.0,
                "registered": True,
            }
        )

    roots = {root for root in DISCOVERY_ROOTS if root.exists()}
    for repo in registered:
        root_path = str(repo.get("rootPath") or "")
        if root_path:
            roots.add(Path(root_path).parent)

    for root in roots:
        for current_root, dirnames, _ in os.walk(root):
            current_path = Path(current_root)
            depth = len(current_path.relative_to(root).parts) if current_path != root else 0
            dirnames[:] = [
                name
                for name in dirnames
                if name not in {".git", "node_modules", "dist", "build", ".next", ".turbo"}
                and not name.startswith(".")
            ]
            if depth > 3:
                dirnames[:] = []
                continue
            if (
                (current_path / ".git").exists()
                or (current_path / "package.json").exists()
                or any(current_path.glob("*.sln"))
                or any(current_path.glob("*.uproject"))
            ):
                root_path = str(current_path)
                if root_path in seen_paths:
                    continue
                seen_paths.add(root_path)
                discovered.append(
                    {
                        "repoId": "",
                        "rootPath": root_path,
                        "aliases": repo_aliases(root_path),
                        "stackFamily": infer_stack_family(root_path),
                        "confidence": 0.8,
                        "registered": False,
                    }
                )
                dirnames[:] = []
    return discovered


def candidate_search_roots() -> list[Path]:
    roots = {root for root in DISCOVERY_ROOTS if root.exists()}
    for repo in list_registered_repos():
        root_path = str(repo.get("rootPath") or "")
        if root_path:
            roots.add(Path(root_path).parent)
    return sorted(roots)


def plausible_repo_names(intent: str) -> list[str]:
    normalized = normalize_phrase(intent)
    base_variants = separator_variants(intent)
    compact_variants = adjacent_swap_variants(normalized.replace(" ", ""))
    names = set(base_variants)
    for variant in compact_variants:
        if variant:
            names.add(variant)
            names.add(variant.lower())
            names.add(variant.title())
            if len(variant) > 3:
                names.add(variant.replace("-", "_"))
    return [name for name in names if name]


def is_repo_like_path(path: Path) -> bool:
    return (
        (path / ".git").exists()
        or (path / "package.json").exists()
        or (path / "README.md").exists()
        or any(path.glob("*.sln"))
        or any(path.glob("*.uproject"))
    )


def direct_discover_repo(intent: str) -> dict[str, Any] | None:
    for root in candidate_search_roots():
        for name in plausible_repo_names(intent):
            candidate = root / name
            if candidate.exists() and candidate.is_dir() and is_repo_like_path(candidate):
                return {
                    "repoId": "",
                    "rootPath": str(candidate),
                    "aliases": repo_aliases(str(candidate)),
                    "stackFamily": infer_stack_family(str(candidate)),
                    "confidence": 0.95,
                    "registered": False,
                }
    return None


def extract_repo_intents_from_goal(goal: str) -> list[str]:
    normalized_goal = normalize_phrase(goal)
    compact_goal = normalized_goal.replace(" ", "")
    intents: list[str] = []

    def maybe_add_intent(intent: str) -> None:
        slug = normalize_phrase(intent).replace(" ", "-")
        if slug and slug not in intents:
            intents.append(slug)

    for repo in list_registered_repos():
        root_path = str(repo.get("rootPath") or "")
        if not root_path:
            continue
        for alias in repo_aliases(root_path):
            if alias_matches_goal(alias, normalized_goal, compact_goal):
                maybe_add_intent(Path(root_path).name)
                break

    for root in candidate_search_roots():
        try:
            entries = list(root.iterdir())
        except Exception:
            continue
        for entry in entries:
            if not entry.is_dir() or not is_repo_like_path(entry):
                continue
            for alias in repo_aliases(str(entry)):
                if alias_matches_goal(alias, normalized_goal, compact_goal):
                    maybe_add_intent(entry.name)
                    break

    return intents


def ensure_repo_profile(conn: Any, repo_ref: dict[str, Any], stack_family: str) -> dict[str, Any]:
    existing = STORE.get_repo_execution_profile(str(repo_ref.get("id") or ""))
    if existing:
        return existing
    return STORE.attach_repo_execution_profile(
        str(repo_ref.get("id") or ""),
        {
            "root_path": str(repo_ref.get("rootPath") or ""),
            "stack_family": stack_family,
            "runner_type": runner_for_stack(stack_family),
            "build_commands": [],
            "test_commands": [],
            "lint_commands": [],
            "artifact_paths": [],
            "sandbox_class": "default",
            "timeout_profile": {},
            "allowed_tools": ["shell", "search"],
            "worker_capabilities": {
                "can_edit_code": True,
                "can_run_tests": True,
                "can_build": True,
                "can_use_browser": False,
                "can_search_web": True,
                "can_run_shell": True,
                "can_open_ide": False,
                "artifact_paths": [],
                "timeout_limits": {},
                "sandbox_class": "default",
            },
        },
    )


def derive_repo_goal_slice(goal: str, repo_alias: str) -> str:
    normalized_repo = normalize_phrase(repo_alias)
    if "subs" in normalized_repo:
        return f"Backend ve ortak contract islerini ilerlet: {goal}"
    if "kronos" in normalized_repo or "unreal" in normalized_repo:
        return f"Unreal gameplay ve oyun iskeletini ilerlet: {goal}"
    if "convert" in normalized_repo:
        return f"Convert Boost uygulama mimarisi ve dosya planini ilerlet: {goal}"
    if "mobile" in normalized_repo:
        return f"Mobil UI ekran ve component akisini ilerlet: {goal}"
    return goal


def resolve_repo_targets(conn: Any, target_repo_intents: list[str], goal: str) -> tuple[list[dict[str, Any]], list[str]]:
    intents = target_repo_intents or extract_repo_intents_from_goal(goal)
    if not intents:
        fallback_repo = infer_repo_for_goal(goal, [])
        if fallback_repo:
            profile = STORE.get_repo_execution_profile(fallback_repo)
            if profile:
                return ([profile], [])
        return ([], [])

    resolved: list[dict[str, Any]] = []
    missing: list[str] = []
    known_profiles = STORE.list_repo_execution_profiles()
    known_profiles_by_id = {str(profile["repoId"]): profile for profile in known_profiles}
    for intent in intents:
        existing_profile = known_profiles_by_id.get(str(intent))
        if existing_profile:
            if not any(existing["repoId"] == existing_profile["repoId"] for existing in resolved):
                resolved.append(existing_profile)
            continue
        candidate = direct_discover_repo(intent)
        if candidate is None:
            missing.append(intent)
            continue
        repo_ref = (
            next(
                (
                    repo
                    for repo in list_registered_repos()
                    if str(repo.get("rootPath") or "") == str(candidate["rootPath"])
                ),
                None,
            )
            if candidate["registered"]
            else ensure_repo_registered(str(candidate["rootPath"]))
        )
        if not repo_ref:
            missing.append(intent)
            continue
        profile = ensure_repo_profile(conn, repo_ref, str(candidate["stackFamily"]))
        if not any(existing["repoId"] == profile["repoId"] for existing in resolved):
            resolved.append(profile)
    return (resolved, missing)


def infer_repo_for_goal(goal: str, active_repos: list[str]) -> str | None:
    if active_repos:
        return str(active_repos[0])
    resolved, _ = resolve_repo_targets(None, [], goal)
    if resolved:
        return str(resolved[0]["repoId"])
    return None


def reserve_dispatch_candidates(limit: int = 4) -> list[dict[str, Any]]:
    with STORE.tx() as conn:
        rows = STORE._fetchall(
            conn,
            """
            SELECT
              s.step_id,
              s.mission_id,
              s.step_class,
              s.repo_id,
              s.inputs_json,
              s.outputs_json,
              m.goal,
              m.active_repos_json,
              m.created_by_surface,
              m.version,
              m.checkpoint_summary
            FROM mission_steps s
            JOIN missions m ON m.mission_id = s.mission_id
            WHERE s.status = ? AND s.requires_approval = 0 AND m.status IN ('pending', 'running')
            ORDER BY s.created_at ASC
            LIMIT ?
            """,
            ("queued", limit),
        )
        candidates: list[dict[str, Any]] = []
        for row in rows:
            dispatched_at = now()
            repo_id = row["repo_id"] or infer_repo_for_goal(
                str(row["goal"] or ""),
                json.loads(row["active_repos_json"] or "[]"),
            )
            conn.execute(
                """
                UPDATE mission_steps
                SET status = ?, worker_id = ?, repo_id = ?, updated_at = ?
                WHERE step_id = ? AND status = ?
                """,
                ("running", "mission-dispatcher", repo_id, dispatched_at, row["step_id"], "queued"),
            )
            conn.execute(
                """
                UPDATE missions
                SET status = ?, current_phase = ?, checkpoint_summary = ?, updated_at = ?, version = version + 1
                WHERE mission_id = ?
                """,
                ("running", "dispatch", "Dispatching mission step to orchestrator.", dispatched_at, row["mission_id"]),
            )
            candidates.append(
                {
                    "mission_id": row["mission_id"],
                    "step_id": row["step_id"],
                    "step_class": row["step_class"],
                    "repo_id": repo_id,
                    "goal": row["goal"],
                    "step_inputs": json.loads(row["inputs_json"] or "{}"),
                    "surface": row["created_by_surface"],
                }
            )
        return candidates


def sync_dispatched_job(
    mission_id: str,
    step_id: str,
    repo_id: str,
    provider: str | None,
    model: str | None,
    job: dict[str, Any],
) -> None:
    timestamp = now()
    job_id = str(job.get("id") or "")
    with STORE.tx() as conn:
        conn.execute(
            """
            UPDATE mission_steps
            SET worker_id = ?, repo_id = ?, outputs_json = ?, updated_at = ?
            WHERE mission_id = ? AND step_id = ?
            """,
            (
                "orchestrator-loop",
                repo_id,
                sqlite_json(
                    {
                        "orchestratorJobId": job_id,
                        "repoId": repo_id,
                        "provider": provider,
                        "model": model,
                    }
                ),
                timestamp,
                mission_id,
                step_id,
            ),
        )
        STORE._insert_checkpoint(
            conn,
            mission_id,
            f"Orchestrator loop job {job_id} queued.",
            {
                "stepId": step_id,
                "jobId": job_id,
                "repoId": repo_id,
                "provider": provider,
                "model": model,
            },
        )


def block_step_without_repo(mission_id: str, step_id: str, goal: str) -> None:
    with STORE.tx() as conn:
        reason = "No repo could be resolved for mission dispatch."
        conn.execute(
            """
            UPDATE mission_steps
            SET status = ?, updated_at = ?
            WHERE mission_id = ? AND step_id = ?
            """,
            ("blocked", now(), mission_id, step_id),
        )
        conn.execute(
            """
            UPDATE missions
            SET status = ?, current_phase = ?, blocked_reason = ?, checkpoint_summary = ?, updated_at = ?, version = version + 1
            WHERE mission_id = ?
            """,
            ("blocked", "blocked", reason, reason, now(), mission_id),
        )
        STORE._insert_checkpoint(conn, mission_id, reason, {"goal": goal})


def list_running_dispatched_steps(limit: int = 8) -> list[dict[str, Any]]:
    with STORE.tx() as conn:
        rows = STORE._fetchall(
            conn,
            """
            SELECT s.step_id, s.mission_id, s.outputs_json
            FROM mission_steps s
            WHERE s.status = ? AND s.worker_id = ?
            ORDER BY s.updated_at ASC
            LIMIT ?
            """,
            ("running", "orchestrator-loop", limit),
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            outputs = json.loads(row["outputs_json"] or "{}")
            job_id = outputs.get("orchestratorJobId")
            if job_id:
                result.append({"mission_id": row["mission_id"], "step_id": row["step_id"], "job_id": str(job_id)})
        return result


def dispatch_once() -> None:
    for candidate in reserve_dispatch_candidates():
        repo_id = candidate["repo_id"]
        if not repo_id:
            block_step_without_repo(candidate["mission_id"], candidate["step_id"], candidate["goal"])
            continue
        try:
            step_inputs = candidate.get("step_inputs") if isinstance(candidate.get("step_inputs"), dict) else {}
            step_goal = (
                str(step_inputs.get("repoGoal"))
                if isinstance(step_inputs.get("repoGoal"), str) and step_inputs.get("repoGoal")
                else candidate["goal"]
            )
            step_provider = (
                str(step_inputs.get("provider"))
                if isinstance(step_inputs.get("provider"), str) and step_inputs.get("provider")
                else DEFAULT_LOOP_PROVIDER or None
            )
            step_model = (
                str(step_inputs.get("model"))
                if isinstance(step_inputs.get("model"), str) and step_inputs.get("model")
                else DEFAULT_LOOP_MODEL or None
            )
            job_response = http_json(
                f"{ORCHESTRATOR_URL}/jobs/loop",
                method="POST",
                body={
                    "repoId": repo_id,
                    "goal": step_goal,
                    "rounds": 2,
                    "executionSurface": "openclaw",
                    "successCriteria": f"Mission progress for: {step_goal}",
                    **({"provider": step_provider} if step_provider else {}),
                    **({"model": step_model} if step_model else {}),
                },
            )
            sync_dispatched_job(
                candidate["mission_id"],
                candidate["step_id"],
                repo_id,
                step_provider,
                step_model,
                job_response,
            )
        except Exception as error:
            block_step_without_repo(
                candidate["mission_id"],
                candidate["step_id"],
                f"{candidate['goal']} | dispatch failed: {error}",
            )


def poll_once() -> None:
    for running in list_running_dispatched_steps():
        try:
            record = http_json(f"{ORCHESTRATOR_URL}/jobs/{running['job_id']}")
        except Exception:
            continue
        job = record.get("job") if isinstance(record, dict) else None
        result = record.get("result") if isinstance(record, dict) else None
        if not isinstance(job, dict):
            continue
        status = str(job.get("status") or "running")
        if status not in {"completed", "failed", "retryable"}:
            continue
        STORE.accept_worker_result(
            "orchestrator-loop",
            {
                "mission_id": running["mission_id"],
                "step_id": running["step_id"],
                "status": status,
                "outputs": {
                    "jobId": running["job_id"],
                    "summary": result.get("summary") if isinstance(result, dict) else None,
                    "result": result if isinstance(result, dict) else {},
                },
                "blocked_reason": result.get("summary") if isinstance(result, dict) else None,
                "idempotency_key": f"{running['job_id']}:{status}",
            },
        )


def mission_dispatch_loop() -> None:
    while True:
        try:
            dispatch_once()
            poll_once()
        except Exception as error:
            print(f"mission-dispatcher warning: {error}")
        time.sleep(DISPATCH_INTERVAL_SECONDS)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        if os.environ.get("LOG_LEVEL", "info").lower() == "silent":
            return
        super().log_message(format, *args)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _write_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self._write_json(
                200,
                {
                    "status": "ok",
                    "package": "langgraph-control-plane",
                    "database": DATABASE_KIND,
                },
            )
            return
        if path == "/missions":
            self._write_json(200, STORE.list_missions())
            return
        if path.startswith("/missions/") and path.endswith("/state"):
            mission_id = path.split("/")[2]
            mission = STORE.get_mission(mission_id)
            if not mission:
                self._write_json(404, {"error": "Mission not found."})
                return
            self._write_json(200, mission)
            return
        if path.startswith("/missions/") and path.endswith("/events"):
            mission_id = path.split("/")[2]
            self._write_json(200, STORE.get_mission_events(mission_id))
            return
        if path.startswith("/missions/") and path.endswith("/steps"):
            mission_id = path.split("/")[2]
            self._write_json(200, STORE.list_steps(mission_id))
            return
        if path.startswith("/missions/") and path.endswith("/checkpoints"):
            mission_id = path.split("/")[2]
            self._write_json(200, STORE.list_checkpoints(mission_id))
            return
        if path.startswith("/threads/"):
            thread_id = path.split("/")[2]
            self._write_json(
                200,
                {"threadId": thread_id, "messages": STORE.get_thread_messages(thread_id)},
            )
            return
        if path == "/repo-profiles":
            self._write_json(200, STORE.list_repo_execution_profiles())
            return
        if path.startswith("/repo-profiles/"):
            repo_id = path.split("/")[2]
            profile = STORE.get_repo_execution_profile(repo_id)
            if not profile:
                self._write_json(404, {"error": "Repo profile not found."})
                return
            self._write_json(200, profile)
            return
        if path == "/approvals":
            self._write_json(200, STORE.list_approvals())
            return
        if path == "/metrics":
            missions = STORE.list_missions()
            status_counts: dict[str, int] = {}
            for mission in missions:
                status = mission["status"]
                status_counts[status] = status_counts.get(status, 0) + 1
            self._write_json(
                200,
                {
                    "missionCount": len(missions),
                    "statusCounts": status_counts,
                },
            )
            return
        self._write_json(404, {"error": "Not found."})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()
        if path == "/missions":
            result = STORE.create_mission(body)
            self._write_json(200 if result.duplicate else 201, result.mission)
            return
        if path.startswith("/missions/") and path.endswith("/commands"):
            mission_id = path.split("/")[2]
            try:
                result = STORE.apply_command(mission_id, body)
            except KeyError:
                self._write_json(404, {"error": "Mission not found."})
                return
            except ValueError as error:
                self._write_json(409, {"error": str(error)})
                return
            self._write_json(200, result.mission)
            return
        if path.startswith("/threads/") and path.endswith("/messages"):
            thread_id = path.split("/")[2]
            message = STORE.append_thread_message(
                thread_id=thread_id,
                role=str(body.get("role") or "user"),
                text=str(body.get("text") or ""),
                surface=str(body.get("surface") or "api"),
                mission_id=body.get("mission_id"),
                idempotency_key=body.get("idempotency_key"),
            )
            self._write_json(201, message)
            return
        if path.startswith("/repo-profiles/"):
            repo_id = path.split("/")[2]
            self._write_json(200, STORE.attach_repo_execution_profile(repo_id, body))
            return
        if path.startswith("/approvals/") and path.endswith("/approve"):
            mission_id = path.split("/")[2]
            try:
                result = STORE.apply_command(
                    mission_id,
                    {
                        "command": "approve",
                        "idempotency_key": body.get("idempotency_key") or str(uuid4()),
                        "surface": body.get("surface") or "api",
                        "surface_event_id": body.get("surface_event_id") or str(uuid4()),
                        **body,
                    },
                )
            except KeyError:
                self._write_json(404, {"error": "Mission not found."})
                return
            except ValueError as error:
                self._write_json(409, {"error": str(error)})
                return
            self._write_json(200, result.mission)
            return
        if path.startswith("/workers/") and path.endswith("/heartbeat"):
            worker_id = path.split("/")[2]
            self._write_json(200, STORE.record_worker_heartbeat(worker_id, body))
            return
        if path.startswith("/workers/") and path.endswith("/results"):
            worker_id = path.split("/")[2]
            self._write_json(200, STORE.accept_worker_result(worker_id, body))
            return
        self._write_json(404, {"error": "Not found."})


def main() -> None:
    STORE.init_db()
    threading.Thread(target=mission_dispatch_loop, name="mission-dispatcher", daemon=True).start()
    port = int(os.environ.get("LANGGRAPH_CONTROL_PORT", "4100"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(
        f"LangGraph control plane listening on http://127.0.0.1:{port} "
        f"using {DATABASE_KIND}"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
