
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional
import uuid

from bson import ObjectId
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .schemas import ChatRequest, ChatResponse, RouteRequest, RouteResponse
from .agent import (
    answer,
    route,
    TOOL_LABELS,
    initialize_mcp,
    shutdown_mcp,
)
from .ingestion import ingest
from .config import DATA_DIR
from . import auth
from . import logging_service as app_logs


@asynccontextmanager
async def lifespan(app: FastAPI):
    auth.seed_database()
    app_logs.initialize_logging()

    from seed_prompts import seed_prompts

    seed_prompts()
    await initialize_mcp()

    try:
        yield
    finally:
        await shutdown_mcp()


app = FastAPI(
    title="Atlas Agentic RAG Assistant",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def attach_trace_id(request: Request, call_next):
    trace_id = request.headers.get("x-trace-id") or str(uuid.uuid4())
    request.state.trace_id = trace_id
    response = await call_next(request)
    response.headers["X-Trace-ID"] = trace_id
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    trace_id = getattr(request.state, "trace_id", str(uuid.uuid4()))
    app_logs.log_error(
        "ERR.ATLAS.API.REQUEST.UNHANDLED_EXCEPTION",
        "Unhandled exception while processing request",
        request=request, trace_id=trace_id, exc=exc,
        source_name="exception_handler",
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An unexpected error occurred. Please try again.",
            "trace_id": trace_id,
        },
        headers={"X-Trace-ID": trace_id},
    )


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=256)
    display_name: str = Field(min_length=1, max_length=120)
    role_id: Optional[str] = None
    role_code: Optional[str] = None


class PromptCreate(BaseModel):
    code: str = Field(
        min_length=2,
        max_length=80,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    name: str = Field(min_length=2, max_length=160)
    category: str = Field(default="general", max_length=80)
    content: str = Field(min_length=1, max_length=30000)
    is_active: bool = True


class PromptUpdate(BaseModel):
    name: Optional[str] = Field(
        default=None, min_length=2, max_length=160
    )
    category: Optional[str] = Field(default=None, max_length=80)
    content: Optional[str] = Field(
        default=None, min_length=1, max_length=30000
    )
    is_active: Optional[bool] = None


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(req: LoginRequest, request: Request):
    user = auth.authenticate(req.username, req.password)

    if not user:
        app_logs.log_error(
            "ERR.ATLAS.AUTH.LOGIN.INVALID_CREDENTIALS",
            "Authentication failed for supplied credentials",
            request=request, trace_id=getattr(request.state, "trace_id", None),
            severity="MEDIUM", source_name="login",
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )

    token = auth._issue(user)
    role = user.get("role_name") or user.get("role_code")
    app_logs.log_event(
        "LOG.ATLAS.USER.LOGIN", "User signed in",
        actor={"id": str(user["_id"]), "username": user["username"],
               "display_name": user.get("display_name"), "role_name": role},
        entity={"type": "user", "id": str(user["_id"])},
        request=request, trace_id=getattr(request.state, "trace_id", None),
    )

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": str(user["_id"]),
            "username": user["username"],
            "display_name": user.get(
                "display_name", user["username"]
            ),
            "role_code": user["role_code"],
            "role_name": user["role_name"],
            "is_admin": bool((auth.permissions.find_one({"role_id": user["role_id"]}, {"grants.prompts.read": 1}) or {}).get("grants", {}).get("prompts.read", False)),
        },
    }


@app.get("/api/auth/me")
def me(user=Depends(auth.current_user)):
    return user


def admin_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "read")


def prompt_create_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "create")


def prompt_update_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "update")


def prompt_delete_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "delete")


@app.post(
    "/api/auth/register",
    status_code=status.HTTP_201_CREATED,
)
def register(req: RegisterRequest, request: Request, user=Depends(admin_user)):
    """
    Register a new user. Only an authenticated account with
    the prompts.read admin permission can use this endpoint.
    """
    created = auth.register_user(
        username=req.username, password=req.password,
        display_name=req.display_name, role_id=req.role_id, role_code=req.role_code,
    )
    app_logs.log_event(
        "LOG.ATLAS.USER.CREATE", "User created",
        actor=user, entity={"type": "user", "id": created["id"]},
        values={"username": created["username"], "role_code": created["role_code"]},
        request=request, trace_id=getattr(request.state, "trace_id", None),
    )
    return created


@app.get("/api/users")
def list_users(user=Depends(admin_user)):
    result = []
    for item in auth.users.find({}).sort("username", 1):
        role = auth.roles.find_one({"_id": item.get("role_id")}) or {}
        result.append({
            "id": str(item["_id"]),
            "username": item.get("username", ""),
            "display_name": item.get("display_name", item.get("username", "")),
            "role_id": str(item["role_id"]) if item.get("role_id") else None,
            "role_code": role.get("code", ""),
            "role_name": role.get("name", "Unknown role"),
            "is_active": item.get("is_active", True),
            "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
        })
    return {"users": result}


@app.post("/api/users", status_code=status.HTTP_201_CREATED)
def create_user(req: RegisterRequest, request: Request, user=Depends(admin_user)):
    created = auth.register_user(
        username=req.username, password=req.password,
        display_name=req.display_name, role_id=req.role_id, role_code=req.role_code,
    )
    app_logs.log_event(
        "LOG.ATLAS.USER.CREATE", "User created",
        actor=user, entity={"type": "user", "id": created["id"]},
        values={"username": created["username"], "role_code": created["role_code"]},
        request=request, trace_id=getattr(request.state, "trace_id", None),
    )
    return created


@app.get("/api/roles")
def list_roles(user=Depends(admin_user)):
    result = []
    for role in auth.roles.find({}).sort("code", 1):
        result.append({
            "id": str(role["_id"]),
            "code": role.get("code", ""),
            "name": role.get("name", ""),
            "is_active": role.get("is_active", True),
        })
    return {"roles": result}


@app.get("/api/prompts")
def list_prompts(user=Depends(admin_user)):
    return {
        "prompts": [
            {
                "id": str(p["_id"]),
                "code": p["code"],
                "name": p["name"],
                "category": p.get("category", "general"),
                "content": p["content"],
                "is_active": p.get("is_active", True),
                "updated_at": (
                    p["updated_at"].isoformat()
                    if p.get("updated_at")
                    else None
                ),
            }
            for p in auth.prompts.find({}).sort("code", 1)
        ]
    }


@app.post(
    "/api/prompts",
    status_code=status.HTTP_201_CREATED,
)
def create_prompt(
    req: PromptCreate,
    request: Request,
    user=Depends(prompt_create_user),
):
    now = datetime.now(timezone.utc)
    doc = (
        req.model_dump()
        if hasattr(req, "model_dump")
        else req.dict()
    )

    doc.update({
        "created_at": now,
        "updated_at": now,
        "created_by": user["id"],
    })

    try:
        result = auth.prompts.insert_one(doc)
    except Exception as exc:
        if "duplicate" in str(exc).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A prompt with this code already exists.",
            )
        raise

    app_logs.log_event(
        "LOG.ATLAS.PROMPT.CREATE", "Prompt created", actor=user,
        entity={"type": "prompt", "id": str(result.inserted_id)},
        values={"code": doc.get("code")}, request=request,
        trace_id=getattr(request.state, "trace_id", None),
    )
    return {"id": str(result.inserted_id), "message": "Prompt created."}


@app.get("/api/prompts/{prompt_id}")
def get_prompt(prompt_id: str, user=Depends(admin_user)):
    try:
        oid = ObjectId(prompt_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    p = auth.prompts.find_one({"_id": oid})

    if not p:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    return {
        "id": str(p["_id"]),
        "code": p["code"],
        "name": p["name"],
        "category": p.get("category", "general"),
        "content": p["content"],
        "is_active": p.get("is_active", True),
    }


@app.put("/api/prompts/{prompt_id}")
def update_prompt(
    prompt_id: str,
    req: PromptUpdate,
    request: Request,
    user=Depends(prompt_update_user),
):
    try:
        oid = ObjectId(prompt_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    changes = (
        req.model_dump(exclude_unset=True)
        if hasattr(req, "model_dump")
        else req.dict(exclude_unset=True)
    )

    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No changes supplied.",
        )

    changes["updated_at"] = datetime.now(timezone.utc)

    result = auth.prompts.update_one(
        {"_id": oid},
        {"$set": changes},
    )

    if not result.matched_count:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    app_logs.log_event(
        "LOG.ATLAS.PROMPT.UPDATE", "Prompt updated", actor=user,
        entity={"type": "prompt", "id": prompt_id},
        values={"changed_fields": sorted(k for k in changes if k != "updated_at")},
        request=request, trace_id=getattr(request.state, "trace_id", None),
    )
    return {"message": "Prompt updated."}


@app.delete("/api/prompts/{prompt_id}")
def delete_prompt(
    prompt_id: str,
    request: Request,
    user=Depends(prompt_delete_user),
):
    try:
        oid = ObjectId(prompt_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    result = auth.prompts.delete_one({"_id": oid})

    if not result.deleted_count:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    app_logs.log_event(
        "LOG.ATLAS.PROMPT.DELETE", "Prompt deleted", actor=user,
        entity={"type": "prompt", "id": prompt_id}, request=request,
        trace_id=getattr(request.state, "trace_id", None),
    )
    return {"message": "Prompt deleted."}


@app.get("/api/admin/audit-logs")
def list_audit_logs(
    user=Depends(admin_user), event_code: Optional[str] = None,
    username: Optional[str] = None, entity_id: Optional[str] = None,
    limit: int = 50, offset: int = 0,
):
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    query = {}
    if event_code: query["eventCode"] = event_code
    if username: query["actor.username"] = {"$regex": re.escape(username), "$options": "i"}
    if entity_id: query["entity.id"] = entity_id
    cursor = app_logs.audit_logs.find(query).sort("_id", -1).skip(offset).limit(limit)
    return {"items": [app_logs.serialize_log(x) for x in cursor],
            "total": app_logs.audit_logs.count_documents(query), "limit": limit, "offset": offset}


@app.get("/api/admin/error-logs")
def list_error_logs(
    user=Depends(admin_user), error_code: Optional[str] = None,
    severity: Optional[str] = None, limit: int = 50, offset: int = 0,
):
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    query = {}
    if error_code: query["errorCode"] = error_code
    if severity: query["errorSeverity"] = severity.upper()
    cursor = app_logs.error_logs.find(query, {"stack": 0}).sort("_id", -1).skip(offset).limit(limit)
    return {"items": [app_logs.serialize_log(x) for x in cursor],
            "total": app_logs.error_logs.count_documents(query), "limit": limit, "offset": offset}


@app.get("/api/admin/audit-logs/events")
def list_audit_event_registry(user=Depends(admin_user)):
    return {"items": list(app_logs.log_master.find({}, {"_id": 0}).sort("eventCode", 1))}


@app.get("/api/admin/error-logs/registry")
def list_error_registry(user=Depends(admin_user)):
    return {"items": list(app_logs.error_master.find({}, {"_id": 0, "devMessage": 0}).sort("errorCode", 1))}


@app.post("/api/route", response_model=RouteResponse)
def route_query(
    req: RouteRequest,
    request: Request,
    user=Depends(auth.current_user),
):
    try:
        plan = route(req.message, req.history)

        return {
            "tool": plan["tool"],
            "tool_label": TOOL_LABELS[plan["tool"]],
            "reason": plan.get("reason", ""),
            "input": plan.get("input") or req.message,
        }
    except Exception as exc:
        app_logs.log_error(
            "ERR.ATLAS.API.ROUTE.ROUTING_FAILED", "Agent route operation failed",
            actor=user, request=request, trace_id=getattr(request.state, "trace_id", None),
            source_name="route_query", exc=exc,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to route this request.",
        )


@app.post("/api/ingest")
def run_ingest(request: Request, user=Depends(admin_user)):
    try:
        return {"status": "ok", "chunks": ingest(force=True)}
    except Exception as exc:
        app_logs.log_error(
            "ERR.ATLAS.API.INGEST.INGESTION_FAILED", "Document ingestion operation failed",
            actor=user, request=request, trace_id=getattr(request.state, "trace_id", None),
            source_name="run_ingest", exc=exc,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Document ingestion failed.",
        )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    request: Request,
    user=Depends(auth.current_user),
):
    try:
        return await answer(
            req.message,
            req.history,
            req.selected_tool,
        )
    except Exception as exc:
        app_logs.log_error(
            "ERR.ATLAS.API.CHAT.ANSWER_FAILED", "Chat answer operation failed",
            actor=user, request=request, trace_id=getattr(request.state, "trace_id", None),
            source_name="chat", exc=exc,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to generate a response. Please try again.",
        )


@app.get("/api/documents")
def documents(user=Depends(auth.current_user)):
    return {
        "documents": sorted(
            p.name for p in DATA_DIR.glob("*.pdf")
        )
    }
