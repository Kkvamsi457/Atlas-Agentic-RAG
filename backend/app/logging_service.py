
import logging
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

from pymongo import DESCENDING

from . import auth

_console = logging.getLogger("atlas.logging")
log_master = auth.db["log_master"]
audit_logs = auth.db["audit_logs"]
error_master = auth.db["error_master"]
error_logs = auth.db["error_logs"]

AUDIT_EVENTS = [
    {"eventCode": "LOG.ATLAS.USER.LOGIN", "description": "User signed in successfully", "messageTemplate": "User signed in", "logType": "AUDIT", "isSensitive": False, "retentionDays": 365, "isActive": True},
    {"eventCode": "LOG.ATLAS.USER.CREATE", "description": "Administrator created a user", "messageTemplate": "User created", "logType": "AUDIT", "isSensitive": True, "retentionDays": 365, "isActive": True},
    {"eventCode": "LOG.ATLAS.PROMPT.CREATE", "description": "Prompt created", "messageTemplate": "Prompt created", "logType": "AUDIT", "isSensitive": True, "retentionDays": 365, "isActive": True},
    {"eventCode": "LOG.ATLAS.PROMPT.UPDATE", "description": "Prompt updated", "messageTemplate": "Prompt updated", "logType": "AUDIT", "isSensitive": True, "retentionDays": 365, "isActive": True},
    {"eventCode": "LOG.ATLAS.PROMPT.DELETE", "description": "Prompt deleted", "messageTemplate": "Prompt deleted", "logType": "AUDIT", "isSensitive": True, "retentionDays": 365, "isActive": True},
]
ERROR_DEFINITIONS = [
    {"errorCode": "ERR.ATLAS.AUTH.LOGIN.INVALID_CREDENTIALS", "errorType": "SECURITY", "errorSeverity": "MEDIUM", "businessArea": "Authentication", "technicalArea": "auth", "thirdParty": None, "userMessage": "Invalid username or password.", "devMessage": "Authentication failed for supplied credentials", "isActive": True},
    {"errorCode": "ERR.ATLAS.API.REQUEST.UNHANDLED_EXCEPTION", "errorType": "SYSTEM", "errorSeverity": "HIGH", "businessArea": "API", "technicalArea": "fastapi", "thirdParty": None, "userMessage": "An unexpected error occurred. Please try again.", "devMessage": "Unhandled exception while processing request", "isActive": True},
    {"errorCode": "ERR.ATLAS.API.ROUTE.ROUTING_FAILED", "errorType": "PROCESSING", "errorSeverity": "HIGH", "businessArea": "Agent", "technicalArea": "routing", "thirdParty": None, "userMessage": "Unable to route this request.", "devMessage": "Agent route operation failed", "isActive": True},
    {"errorCode": "ERR.ATLAS.API.INGEST.INGESTION_FAILED", "errorType": "PROCESSING", "errorSeverity": "HIGH", "businessArea": "Documents", "technicalArea": "ingestion", "thirdParty": None, "userMessage": "Document ingestion failed.", "devMessage": "Document ingestion operation failed", "isActive": True},
    {"errorCode": "ERR.ATLAS.API.CHAT.ANSWER_FAILED", "errorType": "INTEGRATION", "errorSeverity": "HIGH", "businessArea": "Assistant", "technicalArea": "agent", "thirdParty": "Ollama/MCP", "userMessage": "Unable to generate a response. Please try again.", "devMessage": "Chat answer operation failed", "isActive": True},
]

def utcnow():
    return datetime.now(timezone.utc)

def initialize_logging():
    """Create indexes and seed registries without replacing existing definitions."""
    try:
        log_master.create_index("eventCode", unique=True)
        error_master.create_index("errorCode", unique=True)
        audit_logs.create_index([("actor.userId", 1), ("_id", DESCENDING)])
        audit_logs.create_index([("entity.id", 1), ("_id", DESCENDING)])
        audit_logs.create_index([("eventCode", 1), ("_id", DESCENDING)])
        error_logs.create_index([("errorCode", 1), ("_id", DESCENDING)])
        error_logs.create_index([("errorSeverity", 1), ("_id", DESCENDING)])
        error_logs.create_index("traceId")
        for item in AUDIT_EVENTS:
            log_master.update_one({"eventCode": item["eventCode"]}, {"$setOnInsert": item}, upsert=True)
        for item in ERROR_DEFINITIONS:
            item = {**item, "createdAt": utcnow(), "updatedAt": utcnow()}
            error_master.update_one({"errorCode": item["errorCode"]}, {"$setOnInsert": item}, upsert=True)
    except Exception:
        _console.exception("Could not initialize MongoDB audit/error logging")

def _actor(user: dict | None):
    if not user:
        return {"userId": None, "username": "anonymous", "displayName": None, "role": None, "via": "api"}
    return {"userId": str(user.get("id") or user.get("_id") or "") or None,
            "username": user.get("username"), "displayName": user.get("display_name"),
            "role": user.get("role_name") or user.get("role_code"), "via": "api"}

def _request(request):
    if request is None:
        return {}
    # Do not capture headers wholesale or query parameters, which may contain secrets.
    return {"method": request.method, "path": request.url.path,
            "ip": request.client.host if request.client else None,
            "userAgent": request.headers.get("user-agent", "")[:300]}

def log_event(event_code: str, message: str, actor=None, entity=None, values=None, request=None, trace_id=None):
    """Best-effort success audit logger; never raises and never updates existing records."""
    try:
        registry = log_master.find_one({"eventCode": event_code, "isActive": True})
        if not registry:
            _console.error("Audit event code is not registered or inactive: %s", event_code)
            return
        audit_logs.insert_one({
            "eventCode": event_code, "message": message,
            "values": values or {}, "actor": _actor(actor),
            "entity": entity or {}, "request": _request(request),
            "traceId": trace_id, "createdAt": utcnow(),
        })
    except Exception:
        _console.exception("Audit log write failed for event %s", event_code)

def log_error(error_code: str, resolved_message: str, *, actor=None, request=None, trace_id=None,
              severity=None, parameters=None, source_name=None, exc=None):
    """Best-effort error logger. It must never break the application error path."""
    try:
        registry = error_master.find_one({"errorCode": error_code, "isActive": True})
        actual_severity = severity or (registry or {}).get("errorSeverity", "MEDIUM")
        record = {
            "errorCode": error_code, "errorSeverity": actual_severity,
            "resolvedMessage": str(resolved_message)[:2000],
            "parameters": parameters or {}, "actor": _actor(actor),
            "request": {k: v for k, v in _request(request).items() if k != "userAgent"},
            "traceId": trace_id or str(uuid.uuid4()),
            "sourceName": source_name or "api", "environment": "development",
            "createdAt": utcnow(),
        }
        if exc is not None:
            # Stack is for unexpected exceptions only; never include request body or credentials.
            record["stack"] = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-12000:]
        error_logs.insert_one(record)
    except Exception:
        _console.exception("Error log write failed for code %s", error_code)

def serialize_log(item: dict):
    item = dict(item)
    item["id"] = str(item.pop("_id", ""))
    if isinstance(item.get("createdAt"), datetime):
        item["createdAt"] = item["createdAt"].isoformat()
    return item
