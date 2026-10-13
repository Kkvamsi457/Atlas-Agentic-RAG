
import json
import re

from ollama import Client

from .config import OLLAMA_URL, OLLAMA_MODEL, TOP_K
from .mcp_client import MCPClientManager


# Tool names displayed in the frontend.
TOOL_LABELS = {
    "vector_search": "RAG Search",
    "calculator": "Calculator",
    "python": "Python Interpreter Tool",
    "direct": "Direct Answer",
}

# These names must match the tools exposed by your MCP servers.
MCP_TOOL_NAMES = {
    "vector_search": "search_documentation",
    "calculator": "calculate_expression",
    "python": "execute_python_code",
}


def _prompt(code: str) -> str:
    """Load an active prompt from MongoDB."""
    from .auth import get_prompt

    return get_prompt(code)


def _router_system() -> str:
    return _prompt("router_system")


def _answer_system() -> str:
    return _prompt("answer_system")


_mcp_manager = MCPClientManager()


def _client():
    return Client(host=OLLAMA_URL)


async def initialize_mcp():
    """Start MCP client sessions and discover available tools."""
    await _mcp_manager.initialize()


async def shutdown_mcp():
    """Close all MCP client sessions."""
    await _mcp_manager.close()


def get_mcp_tools():
    """Return the tool definitions discovered from connected MCP servers."""
    return _mcp_manager.tools


def is_python_code_request(query: str) -> bool:
    """
    Return True when generating or executing Python code is the
    primary requested output, rather than merely discussing Python docs.
    """
    q = query.lower().strip()

    explicit_code_phrases = [
        "write python code",
        "write a python program",
        "write python program",
        "write a python script",
        "write python script",
        "write a python function",
        "write python function",
        "create python code",
        "create a python program",
        "create a python script",
        "generate python code",
        "generate a python program",
        "generate a python script",
        "implement in python",
        "implement this in python",
        "code in python",
        "python code example",
        "python implementation",
        "python program",
        "python script",
        "python function",
        "python class",
        "debug python",
        "modify python code",
        "fix python code",
        "execute python",
        "run python code",
    ]

    if any(phrase in q for phrase in explicit_code_phrases):
        return True

    # Detect requests that explicitly ask for code using Python concepts.
    concepts = [
        "asyncio",
        "taskgroup",
        "coroutine",
        "threading",
        "multiprocessing",
        "pandas",
        "numpy",
        "flask",
        "fastapi",
        "django",
        "pytest",
    ]

    code_actions = [
        "write",
        "create",
        "generate",
        "implement",
        "build",
        "code example",
        "show code",
        "give me code",
        "provide code",
    ]

    has_concept = any(concept in q for concept in concepts)
    has_code_action = any(action in q for action in code_actions)

    return has_concept and has_code_action


def is_calculation_request(query: str) -> bool:
    """Recognize a plain arithmetic expression."""
    q = query.strip()

    if not re.search(r"\d", q):
        return False

    # Do not classify arbitrary prose containing numbers as arithmetic.
    return bool(
        re.fullmatch(r"[\d\s().+\-*/%^]+", q)
    )


def is_simple_conversation(query: str) -> bool:
    """Recognize common greetings and conversational messages."""
    q = query.lower().strip()
    q = re.sub(r"[!?.]+$", "", q)

    simple_messages = {
        "hi",
        "hello",
        "hey",
        "good morning",
        "good afternoon",
        "good evening",
        "how are you",
        "thanks",
        "thank you",
        "bye",
        "goodbye",
    }

    return q in simple_messages


def is_document_request(query: str) -> bool:
    """
    Identify requests that should use document retrieval rather
    than relying on the model's general knowledge.
    """
    q = query.lower().strip()

    document_phrases = [
        "according to the document",
        "according to the documentation",
        "according to the standard",
        "according to the handbook",
        "according to the specification",
        "according to the framework",
        "what does the document say",
        "what does the documentation say",
        "what does the standard say",
        "what does the handbook say",
        "what does the framework say",
        "in the document",
        "in the documentation",
        "in the handbook",
        "in the standard",
        "from the document",
        "from the documentation",
        "look up",
        "lookup",
        "search the documents",
        "search the documentation",
        "find in the document",
        "document citation",
        "cite the document",
        "with citations",
        "with a citation",
        "cite your sources",
        "n ist sp 800-145",
        "nist sp 800-145",
        "nist special publication 800-145",
        "aws well-architected",
        "well-architected framework",
        "technical handbook",
        "technical document",
        "technical documentation",
    ]

    if any(phrase in q for phrase in document_phrases):
        return True

    # Known document topics in this project should prefer RAG.
    known_document_topics = [
        "asyncio.taskgroup",
        "asyncio taskgroup",
        "python reference documentation",
        "python documentation",
        "python reference",
        "aws framework",
        "aws pillars",
        "six pillars",
        "6 pillars",
        "cloud computing characteristics",
        "on-demand self-service",
    ]

    if any(topic in q for topic in known_document_topics):
        return True

    # Technical standards and publication identifiers are strong
    # signals that the user expects a source-based answer.
    if re.search(r"\bnist\s+sp\s+\d", q):
        return True

    if re.search(r"\bsp\s+800-\d+", q):
        return True

    return False


def _history_messages(history):
    """Normalize recent chat history for Ollama."""
    messages = []

    if not isinstance(history, list):
        return messages

    for item in history[-6:]:
        if not isinstance(item, dict):
            continue

        role = item.get("role")
        content = item.get("content", "")

        if role in ("user", "assistant") and content:
            messages.append({
                "role": role,
                "content": str(content),
            })

    return messages


def _fallback_plan(query: str):
    """Choose a safe tool if the router response is invalid."""
    if is_python_code_request(query):
        return {
            "tool": "python",
            "input": query,
            "reason": "The requested output is Python code.",
        }

    if is_document_request(query):
        return {
            "tool": "vector_search",
            "input": query,
            "reason": "Document-specific request requires retrieval.",
        }

    if is_calculation_request(query):
        return {
            "tool": "calculator",
            "input": query,
            "reason": "The request is a numeric expression.",
        }

    if is_simple_conversation(query):
        return {
            "tool": "direct",
            "input": query,
            "reason": "Simple conversational request.",
        }

    # A technical assistant should prefer retrieval when the router
    # fails to return valid JSON for an ambiguous technical question.
    return {
        "tool": "vector_search",
        "input": query,
        "reason": "Safe fallback to document retrieval.",
    }


def route(query: str, history=None):
    """
    Select the correct tool before generating the answer.

    Priority:
    1. Explicit Python code requests
    2. Document-specific requests
    3. Plain arithmetic
    4. Simple conversation
    5. LLM router
    """
    query = query.strip()

    if not query:
        return {
            "tool": "direct",
            "input": query,
            "reason": "Empty request.",
        }

    # Deterministic rules take precedence over LLM classification.
    if is_python_code_request(query):
        return {
            "tool": "python",
            "input": query,
            "reason": "Python code is the primary requested output.",
        }

    if is_document_request(query):
        return {
            "tool": "vector_search",
            "input": query,
            "reason": "The request requires technical-document retrieval.",
        }

    if is_calculation_request(query):
        return {
            "tool": "calculator",
            "input": query,
            "reason": "The request is an arithmetic expression.",
        }

    if is_simple_conversation(query):
        return {
            "tool": "direct",
            "input": query,
            "reason": "Simple conversational request.",
        }

    # Use the MongoDB-managed router prompt for remaining requests.
    try:
        client = _client()
        messages = [
            {
                "role": "system",
                "content": _router_system(),
            }
        ]

        messages.extend(_history_messages(history))
        messages.append({
            "role": "user",
            "content": query,
        })

        response = client.chat(
            model=OLLAMA_MODEL,
            messages=messages,
            options={"temperature": 0},
        )

        content = response["message"]["content"].strip()

        # Prefer JSON objects enclosed in a code fence or returned alone.
        content = re.sub(
            r"^\s*```(?:json)?\s*|\s*```\s*$",
            "",
            content,
            flags=re.IGNORECASE,
        ).strip()

        match = re.search(r"\{.*\}", content, re.DOTALL)

        if match:
            data = json.loads(match.group(0))
            selected = data.get("tool")

            if selected in TOOL_LABELS:
                # Never allow a model-selected Direct Answer to bypass
                # a known document-retrieval requirement.
                if is_document_request(query):
                    selected = "vector_search"

                return {
                    "tool": selected,
                    "input": data.get("input") or query,
                    "reason": (
                        data.get("reason")
                        or "Selected by the routing agent."
                    ),
                }

    except Exception as exc:
        # Routing failures should not silently turn technical questions
        # into unsupported direct answers.
        fallback = _fallback_plan(query)
        fallback["reason"] = (
            f"{fallback['reason']} Router error: {type(exc).__name__}."
        )
        return fallback

    return _fallback_plan(query)


def _structured_result(result):
    """Read structured MCP output across SDK naming conventions."""
    value = getattr(result, "structured_content", None)

    if value is None:
        value = getattr(result, "structuredContent", None)

    return value


def _text_result(result):
    """Extract text content from an MCP tool response."""
    parts = []

    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", None)

        if text:
            parts.append(text)

    return "\n".join(parts).strip()


def _normalize_rag_result(result):
    """Normalize structured or text-based RAG results."""
    data = _structured_result(result)

    if isinstance(data, dict):
        rows = data.get("results", [])

        if isinstance(rows, list):
            return (
                [row for row in rows if isinstance(row, dict)],
                data.get("message"),
            )

    text = _text_result(result)

    if text:
        try:
            parsed = json.loads(text)

            if isinstance(parsed, dict):
                rows = parsed.get("results", [])

                if isinstance(rows, list):
                    return (
                        [row for row in rows if isinstance(row, dict)],
                        parsed.get("message"),
                    )

        except json.JSONDecodeError:
            pass

    return [], None


def _citation_from_row(row):
    """Build a citation from retrieved metadata."""
    try:
        page = int(row.get("page_number") or 0)
    except (TypeError, ValueError):
        page = 0

    return {
        "document": str(row.get("source_doc") or ""),
        "page": page,
        "section": row.get("section_heading") or None,
    }


async def answer(query: str, history=None, selected_tool=None):
    """Execute the selected tool and produce the final answer."""

    query = query.strip()

    if selected_tool:
        if selected_tool not in TOOL_LABELS:
            raise ValueError(
                f"Unsupported selected tool: {selected_tool}"
            )

        # Do not let a stale or incorrect frontend selection bypass
        # deterministic routing requirements.
        if is_python_code_request(query):
            tool = "python"
        elif is_document_request(query):
            tool = "vector_search"
        elif is_calculation_request(query):
            tool = "calculator"
        else:
            tool = selected_tool

        plan = {
            "tool": tool,
            "input": query,
            "reason": "Tool selected before execution.",
        }
    else:
        plan = route(query, history)

    tool = plan["tool"]
    tool_input = plan.get("input") or query

    if tool not in TOOL_LABELS:
        raise ValueError(f"Unknown tool selected: {tool}")

    steps = [
        f"Agent selected: {TOOL_LABELS[tool]} — "
        f"{plan.get('reason', '')}"
    ]

    citations = []
    context = ""
    prompt = ""

    # ---------------------------------------------------------
    # RAG Search
    # ---------------------------------------------------------
    if tool == "vector_search":
        mcp_name = MCP_TOOL_NAMES["vector_search"]

        result = await _mcp_manager.call_tool(
            mcp_name,
            {
                "query": tool_input,
                "top_k": TOP_K,
            },
        )

        rows, message = _normalize_rag_result(result)

        steps.append(
            f"MCP Client called '{mcp_name}' and retrieved "
            f"{len(rows)} document chunks."
        )

        if message:
            steps.append(str(message))

        # Do not generate unsupported document claims when retrieval
        # returned no usable context.
        if not rows:
            return {
                "answer": (
                    "I couldn't find relevant passages in the indexed "
                    "documents for this question. Please check that the "
                    "required PDF documents have been ingested and indexed, "
                    "then try again."
                ),
                "tool": "vector_search",
                "tool_label": TOOL_LABELS["vector_search"],
                "citations": [],
                "steps": steps,
            }

        citations = [
            _citation_from_row(row)
            for row in rows
        ]

        context = "\n\n".join(
            (
                f"[{row.get('source_doc') or 'Unknown document'}, "
                f"p. {row.get('page_number') or 0}]\n"
                f"{row.get('text') or ''}"
            )
            for row in rows
            if row.get("text")
        )

        if not context.strip():
            return {
                "answer": (
                    "The retrieval tool returned document records, "
                    "but they did not contain usable text. Please check "
                    "the RAG MCP server's result format and indexed data."
                ),
                "tool": "vector_search",
                "tool_label": TOOL_LABELS["vector_search"],
                "citations": [],
                "steps": steps,
            }

        prompt = _prompt("rag_user_template").format(
            query=query,
            context=context,
        )

    # ---------------------------------------------------------
    # Calculator
    # ---------------------------------------------------------
    elif tool == "calculator":
        mcp_name = MCP_TOOL_NAMES["calculator"]

        result = await _mcp_manager.call_tool(
            mcp_name,
            {"expression": tool_input},
        )

        value = _structured_result(result)

        if value is None:
            value = _text_result(result)

        steps.append(
            f"MCP Client called '{mcp_name}' for the numeric expression."
        )

        prompt = _prompt("calculator_user_template").format(
            query=query,
            value=value,
        )

    # ---------------------------------------------------------
    # Python Interpreter
    # ---------------------------------------------------------
    elif tool == "python":
        mcp_name = MCP_TOOL_NAMES["python"]

        result = await _mcp_manager.call_tool(
            mcp_name,
            {"code": tool_input},
        )

        value = _structured_result(result)

        if value is None:
            value = _text_result(result)

        steps.append(
            f"MCP Client called '{mcp_name}' to execute the requested code."
        )

        prompt = _prompt("python_user_template").format(
            query=query,
            value=value,
        )

    # ---------------------------------------------------------
    # Direct Answer
    # ---------------------------------------------------------
    else:
        steps.append("No external tool was required.")

        prompt = _prompt("direct_user_template").format(
            query=query,
        )

    # ---------------------------------------------------------
    # Final answer generation
    # ---------------------------------------------------------
    client = _client()

    messages = [
        {
            "role": "system",
            "content": _answer_system(),
        }
    ]

    messages.extend(_history_messages(history))

    messages.append({
        "role": "user",
        "content": prompt,
    })

    response = client.chat(
        model=OLLAMA_MODEL,
        messages=messages,
        options={"temperature": 0.2},
    )

    final_answer = response["message"]["content"].strip()

    # Deduplicate citations by document and page.
    seen = set()
    unique_citations = []

    for citation in citations:
        key = (
            citation["document"],
            citation["page"],
        )

        if key not in seen:
            seen.add(key)
            unique_citations.append(citation)

    return {
        "answer": final_answer,
        "tool": tool,
        "tool_label": TOOL_LABELS[tool],
        "citations": unique_citations,
        "steps": steps,
    }
