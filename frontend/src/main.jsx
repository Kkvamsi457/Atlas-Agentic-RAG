import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  Bot,
  Calculator,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
  UserRound,
  Settings2,
  LogOut,
  ShieldCheck,
  Save,
  PlusCircle,
  ArrowLeft,
  Users,
  Shield,
  RefreshCw,
  ClipboardList,
  Bug,
} from "lucide-react";

import { createRoot } from "react-dom/client";

import "./styles.css";

const API = "http://127.0.0.1:8000";

const HISTORY_KEY = "atlas-agentic-rag-history-v4";

const ACTIVE_CHAT_KEY = "atlas-agentic-rag-active-chat-v2";

const NEW_CHAT_STATE = "__new_chat__";

const examples = [
  "What are the 6 pillars of the AWS Well-Architected Framework, and which pillar covers incident response?",

  "Look up the asyncio.TaskGroup class in the Python reference documentation and write a minimal code example showing two tasks concurrently.",

  "Using NIST SP 800-145, define the essential characteristics of cloud computing and state if on-demand self-service requires human interaction.",

  "Calculate (1250 \* 0.18) + 47.5.",
];

const toolMeta = {
  vector_search: { label: "RAG Search", icon: Search, className: "rag" },

  calculator: { label: "Calculator", icon: Calculator, className: "calc" },

  python: {
    label: "Python Interpreter Tool",

    icon: Code2,

    className: "python",
  },

  direct: { label: "Direct Answer", icon: Bot, className: "direct" },
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadHistory(historyKey = HISTORY_KEY) {
  try {
    const value = JSON.parse(localStorage.getItem(historyKey) || "[]");

    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function titleFrom(text) {
  const clean = text.replace(/\s+/g, " ").trim();

  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean || "New chat";
}

// Support both the current API flag and role metadata returned by older
// login payloads. Backend endpoints still enforce authorization independently.
function isAdminUser(user) {
  const roleCode = String(user?.role_code ?? user?.roleCode ?? "").trim();
  const roleName = String(user?.role_name ?? user?.roleName ?? user?.role ?? "")
    .trim()
    .toLowerCase();

  return (
    user?.is_admin === true ||
    roleCode === "001" ||
    roleName === "administrator"
  );
}

function ChatApp({
  user,
  onPromptsClick,
  onUsersClick,
  onRolesClick,
  onAuditLogsClick,
  onErrorLogsClick,
  profileOpen,
  onProfileToggle,
  onLogout,
}) {
  // Keep browser history separate for each signed-in account.
  const accountKey = String(user?.username || "guest")
    .trim()
    .toLowerCase();
  const historyKey = `${HISTORY_KEY}:${accountKey}`;
  const activeChatKey = `${ACTIVE_CHAT_KEY}:${accountKey}`;
  const [history, setHistory] = useState(() => loadHistory(historyKey));

  const [activeId, setActiveId] = useState(() => {
    try {
      const saved = localStorage.getItem(activeChatKey);

      if (saved === NEW_CHAT_STATE) return null;

      if (saved) return saved;

      // First-ever load: preserve the previous default behavior and open

      // the first saved conversation. Once New Chat is clicked, the explicit

      // NEW_CHAT_STATE value prevents this fallback on refresh.

      const existingHistory = loadHistory();

      return existingHistory[0]?.id || null;
    } catch {
      return null;
    }
  });

  const [input, setInput] = useState("");

  const [busy, setBusy] = useState(false);

  const [workingLabel, setWorkingLabel] = useState(
    "Agent is deciding which tool to use...",
  );

  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [menuId, setMenuId] = useState(null);

  const [renamingId, setRenamingId] = useState(null);

  const [renameValue, setRenameValue] = useState("");

  const chatRef = useRef(null);

  const activeChat = useMemo(
    () => history.find((chat) => chat.id === activeId) || null,

    [history, activeId],
  );

  const messages = activeChat?.messages || [];

  useEffect(() => {
    localStorage.setItem(historyKey, JSON.stringify(history));
  }, [history, historyKey]);

  // Persist which conversation is open, including the explicit New Chat state.

  // This prevents a refresh from automatically reopening the previous chat.

  useEffect(() => {
    try {
      localStorage.setItem(activeChatKey, activeId || NEW_CHAT_STATE);
    } catch {
      // Ignore storage errors (for example, private browsing restrictions).
    }
  }, [activeId, activeChatKey]);

  // If a previously selected chat was removed outside this component, recover

  // gracefully. Do not select the first chat when the persisted state is New Chat.

  useEffect(() => {
    if (!activeId) return;

    const exists = history.some((chat) => chat.id === activeId);

    if (!exists) {
      setActiveId(null);
    }
  }, [history, activeId]);

  useEffect(() => {
    const el = chatRef.current;

    if (!el) return;

    // A new/empty chat must always start at the top of the landing page.

    // Existing conversations continue to auto-scroll to the newest message.

    if (messages.length === 0) {
      el.scrollTop = 0;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, busy, activeId]);

  const createChat = () => {
    // IMPORTANT: activeId=null is the explicit New Chat state.

    // We intentionally do not create an empty chat object in history.

    // A chat is created only when the user sends the first message.

    setActiveId(null);

    setInput("");

    setBusy(false);

    setMenuId(null);

    setRenamingId(null);

    // Cancel any pending browser scroll and force the empty/new-chat

    // landing view to the top.

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (chatRef.current) {
          chatRef.current.scrollTo({ top: 0, left: 0, behavior: "auto" });
        }
      });
    });

    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  const updateActiveMessages = (nextMessages) => {
    if (!activeId) return;

    setHistory((prev) =>
      prev.map((chat) =>
        chat.id === activeId
          ? { ...chat, messages: nextMessages, updatedAt: Date.now() }
          : chat,
      ),
    );
  };

  const send = async (text = input) => {
    text = text.trim();

    if (!text || busy) return;

    let chatId = activeId;

    let baseMessages = messages;

    if (!chatId) {
      chatId = makeId();

      baseMessages = [];

      const newChat = {
        id: chatId,

        title: titleFrom(text),

        messages: [],

        createdAt: Date.now(),

        updatedAt: Date.now(),
      };

      setHistory((prev) => [newChat, ...prev]);

      setActiveId(chatId);

      try {
        localStorage.setItem(activeChatKey, chatId);
      } catch {}
    } else if (messages.length === 0) {
      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === chatId
            ? { ...chat, title: titleFrom(text), updatedAt: Date.now() }
            : chat,
        ),
      );
    }

    const userMessage = { role: "user", content: text, id: makeId() };

    const nextMessages = [...baseMessages, userMessage];

    setHistory((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? { ...chat, messages: nextMessages, updatedAt: Date.now() }
          : chat,
      ),
    );

    setInput("");

    setWorkingLabel("Agent is deciding which tool to use...");
    setBusy(true);

    // Let React paint the routing status before starting the network request.
    // Without this pause, fast responses can skip the first status visually.
    await new Promise((resolve) => window.setTimeout(resolve, 350));

    setMenuId(null);

    const apiHistory = baseMessages.map((m) => ({
      role: m.role,

      content: m.content || m.answer || "",
    }));

    try {
      const routeResponse = await fetch(`${API}/api/route`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("atlas_access_token") || ""}`,
        },

        body: JSON.stringify({ message: text, history: apiHistory }),
      });

      const plan = await routeResponse.json();

      if (!routeResponse.ok) throw new Error(plan.detail || "Routing failed");

      const selectedTool = plan.tool;

      const normalizedTool = String(selectedTool || "direct").toLowerCase();
      const workingLabels = {
        vector_search: "Using RAG tool...",
        rag: "Using RAG tool...",
        rag_search: "Using RAG tool...",
        python: "Using Python interpreter tool...",
        python_interpreter: "Using Python interpreter tool...",
        calculator: "Using calculator tool...",
        direct: "Direct answer...",
        direct_answer: "Direct answer...",
      };
      const selectedWorkingLabel =
        workingLabels[normalizedTool] ||
        (String(plan.tool_label || "")
          .toLowerCase()
          .includes("python")
          ? "Using Python interpreter tool..."
          : String(plan.tool_label || "")
                .toLowerCase()
                .includes("calc")
            ? "Using calculator tool..."
            : String(plan.tool_label || "")
                  .toLowerCase()
                  .includes("rag") ||
                String(plan.tool_label || "")
                  .toLowerCase()
                  .includes("search")
              ? "Using RAG tool..."
              : "Direct answer...");

      setWorkingLabel(selectedWorkingLabel);

      // Keep the selected-tool status visible long enough to be painted before
      // the answer request begins, even when the backend responds very quickly.
      await new Promise((resolve) => window.setTimeout(resolve, 500));

      const response = await fetch(`${API}/api/chat`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("atlas_access_token") || ""}`,
        },

        body: JSON.stringify({
          message: text,

          history: apiHistory,

          selected_tool: plan.tool,
        }),
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.detail || "Request failed");

      const assistantMessage = { role: "assistant", ...data, id: makeId() };

      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,

                messages: [...chat.messages, assistantMessage],

                updatedAt: Date.now(),
              }
            : chat,
        ),
      );
    } catch (error) {
      const errorMessage = {
        role: "assistant",

        content: `Something went wrong: ${error.message}`,

        tool: "direct",

        tool_label: "Direct Answer",

        citations: [],

        steps: [],

        id: makeId(),
      };

      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,

                messages: [...chat.messages, errorMessage],

                updatedAt: Date.now(),
              }
            : chat,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteChat = (id) => {
    setHistory((prev) => prev.filter((chat) => chat.id !== id));

    setMenuId(null);

    if (activeId === id) {
      const remaining = history.filter((chat) => chat.id !== id);

      const nextId = remaining[0]?.id || null;

      setActiveId(nextId);

      try {
        localStorage.setItem(activeChatKey, nextId || NEW_CHAT_STATE);
      } catch {}
    }
  };

  const clearAll = () => {
    if (!history.length) return;

    if (!window.confirm("Clear all chat history? This cannot be undone."))
      return;

    setHistory([]);

    setActiveId(null);

    try {
      localStorage.setItem(activeChatKey, NEW_CHAT_STATE);
    } catch {}

    setMenuId(null);
  };

  const startRename = (chat) => {
    setRenamingId(chat.id);

    setRenameValue(chat.title);

    setMenuId(null);
  };

  const saveRename = () => {
    if (!renamingId) return;

    const value = renameValue.trim();

    if (value) {
      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === renamingId
            ? { ...chat, title: value, updatedAt: Date.now() }
            : chat,
        ),
      );
    }

    setRenamingId(null);
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="sidebar-header">
          <div className="brand">
            <div className="brandmark">
              <Sparkles size={19} />
            </div>

            <div>
              <strong>Atlas</strong>

              <span>Agentic RAG</span>
            </div>
          </div>

          <button
            className="mobile-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        <button className="new-chat" onClick={createChat}>
          <Plus size={17} />

          <span>New chat</span>

          <kbd>Ctrl K</kbd>
        </button>

        <div className="history-area">
          <div className="section-heading">
            <span>Chat history</span>

            <span className="history-count">{history.length}</span>
          </div>

          <div className="history-list">
            {history.length === 0 ? (
              <div className="history-empty">
                <MessageSquare size={19} />

                <p>No conversations yet.</p>

                <span>Your chats will appear here.</span>
              </div>
            ) : (
              history.map((chat) => (
                <div
                  key={chat.id}
                  className={`history-item ${chat.id === activeId ? "active" : ""}`}
                  onClick={() => {
                    setActiveId(chat.id);

                    try {
                      localStorage.setItem(activeChatKey, chat.id);
                    } catch {}

                    setMenuId(null);

                    if (window.innerWidth < 900) setSidebarOpen(false);
                  }}
                >
                  <MessageSquare size={16} />

                  {renamingId === chat.id ? (
                    <input
                      autoFocus
                      className="rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename();

                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={saveRename}
                    />
                  ) : (
                    <span className="history-title">{chat.title}</span>
                  )}

                  <button
                    className="history-menu"
                    onClick={(e) => {
                      e.stopPropagation();

                      setMenuId(menuId === chat.id ? null : chat.id);
                    }}
                    aria-label="Chat options"
                  >
                    <MoreHorizontal size={16} />
                  </button>

                  {menuId === chat.id && (
                    <div
                      className="chat-menu"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button onClick={() => startRename(chat)}>
                        <Pencil size={14} /> Rename
                      </button>

                      <button
                        className="danger"
                        onClick={() => deleteChat(chat.id)}
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <button
            className="clear-history"
            onClick={clearAll}
            disabled={!history.length}
          >
            <Trash2 size={15} />

            <span>Clear all history</span>
          </button>

          <div className="sidebar-note">
            Your conversations are saved locally in this browser.
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div className="mobile-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? <ChevronLeft size={20} /> : <Menu size={20} />}
          </button>

          <div className="top-title">
            <span className="online-dot" />
            <span>Technical Assistant</span>
          </div>

          <div className="topbar-actions">
            {/* Users, Roles and Prompts remain visible to everyone.
                Clicking navigates to the destination screen; non-admins see
                a 403 Forbidden message there. Audit/Error Logs stay admin-only. */}
            <button className="top-nav-btn" onClick={() => onUsersClick?.()}>
              <Users size={17} /> Users
            </button>
            <button className="top-nav-btn" onClick={() => onRolesClick?.()}>
              <Shield size={17} /> Roles
            </button>
            <button className="top-nav-btn" onClick={() => onPromptsClick?.()}>
              <Settings2 size={17} /> Prompts
            </button>
            {isAdminUser(user) && (
              <>
                <button className="top-nav-btn" onClick={onAuditLogsClick}>
                  <ClipboardList size={17} /> Audit Logs
                </button>
                <button className="top-nav-btn" onClick={onErrorLogsClick}>
                  <Bug size={17} /> Error Logs
                </button>
              </>
            )}
            <div className="profile-wrap">
              <button className="profile-trigger" onClick={onProfileToggle}>
                <span className="profile-avatar">
                  <UserRound size={17} />
                </span>
                <span className="profile-label">
                  {user.display_name || user.username}
                </span>
                <ChevronDown size={15} />
              </button>
              {profileOpen && (
                <div className="profile-dropdown">
                  <div className="profile-detail">
                    <strong>{user.display_name || user.username}</strong>
                    <span>{user.username}</span>
                    <small>Role: {user.role_name || user.role_code}</small>
                  </div>
                  <button onClick={onLogout}>
                    <LogOut size={15} /> Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <section className="chat-scroll" ref={chatRef}>
          {messages.length === 0 ? (
            <>
              <LandingPage onExample={send} />
              {busy && <WorkingIndicator label={workingLabel} />}
            </>
          ) : (
            <div className="conversation">
              {messages.map((message) => (
                <Message
                  key={message.id || `${message.role}-${Math.random()}`}
                  message={message}
                />
              ))}

              {busy && <WorkingIndicator label={workingLabel} />}
            </div>
          )}
        </section>

        <div className="composer-area">
          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();

                  send();
                }
              }}
              placeholder="Ask about Python, AWS, NIST, or calculate something..."
              rows="1"
              disabled={busy}
            />

            <button
              className="send-button"
              disabled={busy || !input.trim()}
              onClick={() => send()}
              aria-label="Send message"
            >
              <Send size={17} />
            </button>
          </div>

          <div className="composer-hint">
            Enter to send · Shift + Enter for a new line · Agent routing happens
            automatically
          </div>
        </div>
      </main>
    </div>
  );
}

function LandingPage({ onExample }) {
  return (
    <div className="landing">
      <div className="landing-glow glow-one" />

      <div className="landing-glow glow-two" />

      <div className="hero-logo">
        <Sparkles size={27} />
      </div>

      <div className="eyebrow">AGENTIC RAG · MULTI-TOOL ASSISTANT</div>

      <h1>
        Intelligent answers,
        <br />
        <span>grounded in your documents.</span>
      </h1>

      <p className="hero-copy">
        Atlas routes every request to the right tool — RAG Search, Python
        Interpreter, Calculator, or Direct Answer — then presents the result
        with clear sources.
      </p>

      <div className="tool-strip">
        <ToolMini icon={<Search size={15} />} label="RAG Search" color="blue" />

        <ToolMini
          icon={<Code2 size={15} />}
          label="Python Interpreter"
          color="green"
        />

        <ToolMini
          icon={<Calculator size={15} />}
          label="Calculator"
          color="purple"
        />

        <ToolMini icon={<Bot size={15} />} label="Direct Answer" color="gray" />
      </div>

      <div className="example-heading">Try an example</div>

      <div className="example-grid">
        {examples.map((example, index) => (
          <button
            className="example-card"
            key={index}
            onClick={() => onExample(example)}
          >
            <span>{example}</span>

            <ChevronRight size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolMini({ icon, label, color }) {
  return (
    <div className={`tool-mini ${color}`}>
      {icon}

      <span>{label}</span>
    </div>
  );
}

function WorkingIndicator({ label }) {
  return (
    <div className="working-row">
      <div className="assistant-avatar working-avatar">
        <Bot size={16} />
      </div>

      <div className="working-card">
        <div className="working-dots">
          <i />

          <i />

          <i />
        </div>

        <span>{label}</span>
      </div>
    </div>
  );
}

function Message({ message }) {
  if (message.role === "user") {
    return (
      <div className="message-row user-message-row">
        <div className="user-bubble">{message.content}</div>
      </div>
    );
  }

  const meta = toolMeta[message.tool] || toolMeta.direct;

  const Icon = meta.icon;

  const answer = message.answer || message.content || "";

  return (
    <div className="message-row assistant-row">
      <div className="assistant-avatar">
        <Bot size={17} />
      </div>

      <div className="assistant-content">
        <div className={`tool-chip ${meta.className}`}>
          <Icon size={14} />

          <span>{message.tool_label || meta.label}</span>

          <span className="tool-check">
            <Check size={11} />
          </span>
        </div>

        <div className="route-line">
          <span className="route-agent">Agent</span>

          <span>→</span>

          <strong>{message.tool_label || meta.label}</strong>

          <span>→</span>

          <span>Answer</span>
        </div>

        {message.steps?.map((step, index) => (
          <div className="step" key={index}>
            ✓ {step}
          </div>
        ))}

        <div className="answer-card">
          <RichAnswer text={answer} />

          <div className="answer-actions">
            <CopyButton text={answer} />
          </div>
        </div>

        {message.citations?.length > 0 && (
          <div className="citations">
            <div className="citations-title">
              <FileText size={13} /> Sources
            </div>

            <div className="citation-list">
              {message.citations.map((citation, index) => (
                <div
                  className="citation"
                  key={`${citation.document}-${citation.page}-${index}`}
                >
                  <FileText size={13} />

                  <span>{citation.document}</span>

                  <b>p. {citation.page}</b>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);

      setCopied(true);

      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button className="copy-answer" onClick={copy} title="Copy answer">
      {copied ? <Check size={14} /> : <Copy size={14} />}

      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function RichAnswer({ text }) {
  const parts = text.split(/(```[\s\S]\\\*?```)/g);

  return (
    <div className="rich-answer">
      {parts.map((part, index) => {
        if (!part.startsWith("```")) {
          return <TextBlock key={index} text={part} />;
        }

        const lines = part

          .replace(/^```/, "")

          .replace(/```$/, "")

          .replace(/^\n/, "")

          .split("\n");

        const language = lines[0]?.trim() || "code";

        const code = lines.slice(1).join("\n");

        return <CodeBlock key={index} language={language} code={code} />;
      })}
    </div>
  );
}

function TextBlock({ text }) {
  if (!text.trim()) return null;

  const lines = text.split("\n");

  return (
    <div className="text-block">
      {lines.map((line, index) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("### "))
          return <h4 key={index}>{trimmed.slice(4)}</h4>;

        if (trimmed.startsWith("## "))
          return <h3 key={index}>{trimmed.slice(3)}</h3>;

        if (trimmed.startsWith("# "))
          return <h2 key={index}>{trimmed.slice(2)}</h2>;

        if (/^[-\\\*]\s+/.test(trimmed))
          return (
            <div className="answer-list" key={index}>
              <span>•</span>

              {trimmed.replace(/^[-\\\*]\s+/, "")}
            </div>
          );

        if (/^\d+\.\s+/.test(trimmed))
          return (
            <div className="answer-list" key={index}>
              <span>{trimmed.match(/^\d+/)[0]}.</span>

              {trimmed.replace(/^\d+\.\s+/, "")}
            </div>
          );

        return <p key={index}>{formatInline(line)}</p>;
      })}
    </div>
  );
}

function formatInline(text) {
  const pieces = text.split(
    /(`[^`]+`|\\\\\\\*\\\\\\\*[^\\\*]+\\\\\\\*\\\\\\\*)/g,
  );

  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`"))
      return (
        <code className="inline-code" key={index}>
          {piece.slice(1, -1)}
        </code>
      );

    if (piece.startsWith("\\\*\\\*") && piece.endsWith("\\\*\\\*"))
      return <strong key={index}>{piece.slice(2, -2)}</strong>;

    return <React.Fragment key={index}>{piece}</React.Fragment>;
  });
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);

      setCopied(true);

      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language || "code"}</span>

        <button onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>

      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem("atlas_access_token") || "",
  );
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_user") || "null");
    } catch {
      return null;
    }
  });
  const [page, setPage] = useState("chat");
  const [profileOpen, setProfileOpen] = useState(false);
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error("Session expired");
        return r.json();
      })
      .then((u) => {
        setUser(u);
        localStorage.setItem("atlas_user", JSON.stringify(u));
      })
      .catch(() => {
        localStorage.removeItem("atlas_access_token");
        localStorage.removeItem("atlas_user");
        setToken("");
        setUser(null);
      });
  }, []);
  async function login(e) {
    e.preventDefault();
    setLoginError("");
    setLoginBusy(true);
    try {
      const r = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginName, password: loginPassword }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Login failed");
      localStorage.setItem("atlas_access_token", data.access_token);
      localStorage.setItem("atlas_user", JSON.stringify(data.user));
      setToken(data.access_token);
      setUser(data.user);
      setPage("chat");
    } catch (err) {
      setLoginError(err.message || "Unable to sign in");
    } finally {
      setLoginBusy(false);
    }
  }
  function logout() {
    // Preserve this account's saved chat history, but clear the selected chat.
    // On the next login, the sidebar history remains available while the main
    // panel starts on a fresh chat landing page.
    const username = String(user?.username || "")
      .trim()
      .toLowerCase();
    if (username) {
      localStorage.removeItem(`${ACTIVE_CHAT_KEY}:${username}`);
    }

    localStorage.removeItem("atlas_access_token");
    localStorage.removeItem("atlas_user");

    // Clear controlled login fields as well as authentication state.
    setLoginName("");
    setLoginPassword("");
    setLoginError("");
    setToken("");
    setUser(null);
    setPage("chat");
    setProfileOpen(false);
  }
  if (!token || !user)
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={login} autoComplete="off">
          <div className="auth-logo">
            <ShieldCheck size={25} />
          </div>
          <h1>Atlas Agentic RAG</h1>
          <p>Sign in to continue to your assistant.</p>
          <label>Username</label>
          <input
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
            autoComplete="off"
            required
          />
          <label>Password</label>
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          {loginError && <div className="auth-error">{loginError}</div>}
          <button className="primary-btn" disabled={loginBusy}>
            {loginBusy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  return (
    <div className="signed-in-app">
      {page !== "chat" ? (
        <>
          <header className="top-app-bar">
            <button
              className="top-nav-btn active"
              onClick={() => setPage("chat")}
            >
              <ArrowLeft size={17} /> Back to Assistant
            </button>
            {isAdminUser(user) && (
              <div className="admin-page-nav">
                <button
                  className={`top-nav-btn ${page === "users" ? "active" : ""}`}
                  onClick={() => setPage("users")}
                >
                  <Users size={16} /> Users
                </button>
                <button
                  className={`top-nav-btn ${page === "roles" ? "active" : ""}`}
                  onClick={() => setPage("roles")}
                >
                  <Shield size={16} /> Roles
                </button>
                <button
                  className={`top-nav-btn ${page === "prompts" ? "active" : ""}`}
                  onClick={() => setPage("prompts")}
                >
                  <Settings2 size={16} /> Prompts
                </button>
                <button
                  className={`top-nav-btn ${page === "audit-logs" ? "active" : ""}`}
                  onClick={() => setPage("audit-logs")}
                >
                  <ClipboardList size={16} /> Audit Logs
                </button>
                <button
                  className={`top-nav-btn ${page === "error-logs" ? "active" : ""}`}
                  onClick={() => setPage("error-logs")}
                >
                  <Bug size={16} /> Error Logs
                </button>
              </div>
            )}
            <div className="profile-wrap">
              <button
                className="profile-trigger"
                onClick={() => setProfileOpen((v) => !v)}
              >
                <span className="profile-avatar">
                  <UserRound size={17} />
                </span>
                <span className="profile-label">
                  {user.display_name || user.username}
                </span>
                <ChevronDown size={15} />
              </button>
              {profileOpen && (
                <div className="profile-dropdown">
                  <div className="profile-detail">
                    <strong>{user.display_name || user.username}</strong>
                    <span>{user.username}</span>
                    <small>Role: {user.role_name || user.role_code}</small>
                  </div>
                  <button onClick={logout}>
                    <LogOut size={15} /> Logout
                  </button>
                </div>
              )}
            </div>
          </header>
          {!isAdminUser(user) ? (
            <ForbiddenScreen message="user do not have access." />
          ) : page === "prompts" ? (
            <PromptsPage
              user={user}
              token={token}
              onBack={() => setPage("chat")}
            />
          ) : page === "users" ? (
            <UsersPage user={user} token={token} />
          ) : page === "roles" ? (
            <RolesPage user={user} token={token} />
          ) : page === "audit-logs" ? (
            <LogsPage kind="audit" token={token} />
          ) : (
            <LogsPage kind="error" token={token} />
          )}
        </>
      ) : (
        <div className="chat-app-area">
          <ChatApp
            key={String(user.username || "").toLowerCase()}
            user={user}
            onPromptsClick={() => {
              setProfileOpen(false);
              setPage("prompts");
            }}
            onUsersClick={() => {
              setProfileOpen(false);
              setPage("users");
            }}
            onRolesClick={() => {
              setProfileOpen(false);
              setPage("roles");
            }}
            onAuditLogsClick={() => {
              setProfileOpen(false);
              setPage("audit-logs");
            }}
            onErrorLogsClick={() => {
              setProfileOpen(false);
              setPage("error-logs");
            }}
            profileOpen={profileOpen}
            onProfileToggle={() => setProfileOpen((v) => !v)}
            onLogout={logout}
          />
        </div>
      )}
    </div>
  );
}

function ForbiddenScreen({ message = "user do not have access." }) {
  return (
    <main
      className="admin-page access-denied-page"
      role="alert"
      style={{
        minHeight: "calc(100vh - 155px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 24px",
        background: "#f5f8ff",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 520,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 16,
          padding: "38px 32px",
          border: "1px solid #dce5f4",
          borderRadius: 20,
          background: "#ffffff",
          boxShadow: "0 16px 42px rgba(34, 63, 110, 0.10)",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            display: "grid",
            placeItems: "center",
            background: "#fff0f0",
            color: "#dc2626",
          }}
        >
          <ShieldCheck size={34} strokeWidth={1.9} />
        </div>
        <h1
          style={{
            margin: 0,
            color: "#172b4d",
            fontSize: 28,
            lineHeight: 1.25,
          }}
        >
          403 Forbidden
        </h1>
        <p
          style={{ margin: 0, color: "#536783", fontSize: 16, lineHeight: 1.6 }}
        >
          {message}
        </p>
      </section>
    </main>
  );
}

function LogsPage({ kind, token }) {
  const audit = kind === "audit";
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const endpoint = audit ? "/api/admin/audit-logs" : "/api/admin/error-logs";
  async function load(nextPage = page) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(nextPage * pageSize),
      });
      if (filter.trim())
        params.set(audit ? "event_code" : "error_code", filter.trim());
      const response = await fetch(`${API}${endpoint}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load logs");
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      setError(e.message || "Unable to load logs");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load(page);
  }, [kind, page]);
  const formatDate = (value) => {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };
  return (
    <main className="admin-page">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">ADMINISTRATION / MONITORING</span>
          <h1>{audit ? "Audit Logs" : "Error Logs"}</h1>
          <p>
            {audit
              ? "Read-only history of successful auditable actions."
              : "Structured application failures and diagnostics."}
          </p>
        </div>
        <button
          className="primary-btn"
          onClick={() => load(page)}
          disabled={loading}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <section className="admin-card logs-card">
        <div className="logs-toolbar">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={
              audit ? "Filter by event code…" : "Filter by error code…"
            }
          />
          <button
            className="secondary-btn"
            onClick={() => {
              setPage(0);
              load(0);
            }}
            disabled={loading}
          >
            Apply filter
          </button>
          <span>
            {total} record{total === 1 ? "" : "s"}
          </span>
        </div>
        {error && <div className="inline-error">{error}</div>}
        {loading ? (
          <p className="logs-empty">Loading logs…</p>
        ) : items.length === 0 ? (
          <p className="logs-empty">No log records found.</p>
        ) : (
          <div className="logs-list">
            {items.map((item) => (
              <article className="log-record" key={item.id}>
                <div className="log-record-head">
                  <strong>{audit ? item.eventCode : item.errorCode}</strong>
                  {!audit && (
                    <span
                      className={`severity-pill severity-${String(item.errorSeverity || "medium").toLowerCase()}`}
                    >
                      {item.errorSeverity || "MEDIUM"}
                    </span>
                  )}
                  <time>{formatDate(item.createdAt)}</time>
                </div>
                <p>{audit ? item.message : item.resolvedMessage}</p>
                <div className="log-meta">
                  <span>
                    <b>Actor:</b> {item.actor?.username || "anonymous"}
                    {item.actor?.role ? ` · ${item.actor.role}` : ""}
                  </span>
                  {item.entity?.type && (
                    <span>
                      <b>Entity:</b> {item.entity.type} {item.entity.id || ""}
                    </span>
                  )}
                  {item.traceId && (
                    <span>
                      <b>Trace:</b> {item.traceId}
                    </span>
                  )}
                  {item.request?.method && (
                    <span>
                      <b>Request:</b> {item.request.method} {item.request.path}
                    </span>
                  )}
                </div>
                <details>
                  <summary>Details</summary>
                  <pre>
                    {JSON.stringify(
                      audit
                        ? {
                            values: item.values,
                            entity: item.entity,
                            request: item.request,
                          }
                        : {
                            parameters: item.parameters,
                            sourceName: item.sourceName,
                            request: item.request,
                          },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </article>
            ))}
          </div>
        )}
        <div className="logs-pagination">
          <button
            className="secondary-btn"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {Math.max(1, Math.ceil(total / pageSize))}
          </span>
          <button
            className="secondary-btn"
            onClick={() => setPage((p) => p + 1)}
            disabled={loading || (page + 1) * pageSize >= total}
          >
            Next
          </button>
        </div>
        {audit && (
          <p className="logs-footnote">
            Audit entries are immutable. This interface does not provide edit or
            delete actions.
          </p>
        )}
      </section>
    </main>
  );
}

function PromptsPage({ user, token, onBack }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    code: "",
    name: "",
    category: "general",
    content: "",
    is_active: true,
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`${API}/api/prompts`, { headers });
      const d = await r.json();
      if (!r.ok)
        throw new Error(
          r.status === 403
            ? "403 Forbidden — you do not have access to prompts."
            : d.detail || "Unable to load prompts",
        );
      setItems(d.prompts || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  if (!loading && error.startsWith("403 Forbidden")) {
    return (
      <ForbiddenScreen
        message={
          error.replace(/^403 Forbidden\s*[—-]?\s*/i, "") ||
          "user do not have access."
        }
      />
    );
  }
  function reset() {
    setEditing(null);
    setForm({
      code: "",
      name: "",
      category: "general",
      content: "",
      is_active: true,
    });
  }
  async function save(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      const url = editing
        ? `${API}/api/prompts/${editing.id}`
        : `${API}/api/prompts`;
      const payload = editing
        ? {
            name: form.name,
            category: form.category,
            content: form.content,
            is_active: form.is_active,
          }
        : form;
      const r = await fetch(url, {
        method: editing ? "PUT" : "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok)
        throw new Error(
          r.status === 403
            ? "403 Forbidden — you do not have permission to manage prompts."
            : d.detail || "Could not save prompt",
        );
      setNotice(
        editing
          ? "Prompt updated successfully."
          : "Prompt created successfully.",
      );
      reset();
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove(item) {
    if (!confirm(`Delete prompt “${item.name}”?`)) return;
    try {
      const r = await fetch(`${API}/api/prompts/${item.id}`, {
        method: "DELETE",
        headers,
      });
      const d = await r.json();
      if (!r.ok)
        throw new Error(
          r.status === 403
            ? "403 Forbidden — you do not have permission to delete prompts."
            : d.detail || "Delete failed",
        );
      setNotice("Prompt deleted.");
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <main className="prompts-page">
      <div className="prompts-heading">
        <div>
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={16} /> Back to chat
          </button>
          <h1>Prompt Management</h1>
          <p>
            Manage the prompts used by the routing and answer-generation agents.
          </p>
        </div>
        <button
          className="primary-btn add-prompt"
          onClick={() => {
            reset();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <PlusCircle size={16} /> New prompt
        </button>
      </div>
      {error && <div className="notice error-notice">{error}</div>}
      {notice && <div className="notice success-notice">{notice}</div>}
      <div className="prompt-workspace">
        <section className="prompt-list-card">
          <div className="prompt-list-header">
            <strong>Stored prompts</strong>
            <span>{items.length} prompts</span>
          </div>
          {loading ? (
            <p className="empty-state">Loading prompts…</p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                className={`prompt-list-item ${editing?.id === item.id ? "selected" : ""}`}
                onClick={() => {
                  setEditing(item);
                  setForm({ ...item });
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.code} · {item.category}
                  </small>
                </span>
                <span
                  className={`status-pill ${item.is_active ? "enabled" : "disabled"}`}
                >
                  {item.is_active ? "Active" : "Inactive"}
                </span>
              </button>
            ))
          )}
        </section>
        <form className="prompt-editor-card" onSubmit={save}>
          <h2>{editing ? "Edit prompt" : "Create prompt"}</h2>
          <p>Changes are stored in MongoDB and used by the agent.</p>
          <label>Prompt code</label>
          <input
            value={form.code || ""}
            disabled={!!editing}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            placeholder="e.g. answer_system"
            required
            minLength={2}
          />
          <label>Display name</label>
          <input
            value={form.name || ""}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <label>Category</label>
          <input
            value={form.category || "general"}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
          <label>Prompt content</label>
          <textarea
            className="prompt-content-input"
            value={form.content || ""}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            required
            rows={12}
          />
          <label className="active-toggle">
            <input
              type="checkbox"
              checked={form.is_active !== false}
              onChange={(e) =>
                setForm({ ...form, is_active: e.target.checked })
              }
            />{" "}
            Active prompt
          </label>
          <div className="prompt-form-actions">
            <button type="submit" className="primary-btn">
              <Save size={15} />
              {editing ? "Save changes" : "Create prompt"}
            </button>
            {editing && (
              <button
                type="button"
                className="secondary-btn danger-btn"
                onClick={() => remove(editing)}
              >
                Delete
              </button>
            )}
            {editing && (
              <button type="button" className="secondary-btn" onClick={reset}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

function AdminOnlyNotice() {
  return (
    <main className="admin-page">
      <div className="admin-denied">
        <ShieldCheck size={36} />
        <h2>403 Forbidden</h2>
        <p>You do not have access to this page.</p>
      </div>
    </main>
  );
}

function UsersPage({ user, token }) {
  const [items, setItems] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    username: "",
    display_name: "",
    password: "",
    role_id: "",
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [usersResponse, rolesResponse] = await Promise.all([
        fetch(`${API}/api/users`, { headers }),
        fetch(`${API}/api/roles`, { headers }),
      ]);
      const usersData = await usersResponse.json();
      const rolesData = await rolesResponse.json();
      if (!usersResponse.ok)
        throw new Error(
          usersResponse.status === 403
            ? "403 Forbidden — you do not have access to Users."
            : usersData.detail ||
                `Unable to load users (HTTP ${usersResponse.status})`,
        );
      if (!rolesResponse.ok)
        throw new Error(
          rolesResponse.status === 403
            ? "403 Forbidden — you do not have access to Roles."
            : rolesData.detail ||
                `Unable to load roles (HTTP ${rolesResponse.status})`,
        );
      setItems(usersData.users || []);
      const activeRoles = (rolesData.roles || []).filter(
        (role) => role.is_active,
      );
      setRoles(activeRoles);
      setForm((previous) => ({
        ...previous,
        role_id:
          previous.role_id ||
          activeRoles.find((r) => r.code === "002")?.id ||
          activeRoles[0]?.id ||
          "",
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  if (!loading && error.startsWith("403 Forbidden")) {
    return (
      <ForbiddenScreen
        message={
          error.replace(/^403 Forbidden\s*[—-]?\s*/i, "") ||
          "user do not have access."
        }
      />
    );
  }

  async function createUser(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const response = await fetch(`${API}/api/users`, {
        method: "POST",
        headers,
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "403 Forbidden — you do not have permission to create users."
            : data.detail || "Unable to create user",
        );
      setNotice(`User "${data.username}" created successfully.`);
      setForm({
        username: "",
        display_name: "",
        password: "",
        role_id: roles.find((r) => r.code === "002")?.id || roles[0]?.id || "",
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="admin-eyebrow">ACCESS CONTROL</p>
          <h1>Users</h1>
          <p>View registered accounts and add users to Atlas Agentic RAG.</p>
        </div>
        <button className="secondary-btn" onClick={load} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {error && <div className="notice error-notice">{error}</div>}
      {notice && <div className="notice success-notice">{notice}</div>}
      <div className="admin-grid">
        <form className="admin-card user-create-form" onSubmit={createUser}>
          <div className="admin-card-title">
            <Users size={19} />
            <div>
              <h2>Add user</h2>
              <p>Create a new account with a role from the database.</p>
            </div>
          </div>
          <label>Username</label>
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            minLength={1}
            maxLength={80}
            autoComplete="off"
            required
          />
          <label>Display name</label>
          <input
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            minLength={1}
            maxLength={120}
            required
          />
          <label>Password</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            minLength={8}
            maxLength={256}
            autoComplete="new-password"
            required
          />
          <label>Role</label>
          <select
            value={form.role_id}
            onChange={(e) => setForm({ ...form, role_id: e.target.value })}
            required
          >
            <option value="" disabled>
              Select a role
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.code} — {role.name}
              </option>
            ))}
          </select>
          <button
            className="primary-btn"
            type="submit"
            disabled={saving || !roles.length}
          >
            {saving ? "Creating user…" : "Create user"}
          </button>
          {!roles.length && !loading && (
            <small className="form-hint">
              No active roles are available. Check the Roles collection.
            </small>
          )}
        </form>
        <section className="admin-card user-list-card">
          <div className="admin-card-title">
            <Users size={19} />
            <div>
              <h2>Existing users</h2>
              <p>
                {items.length} account{items.length === 1 ? "" : "s"} registered
              </p>
            </div>
          </div>
          {loading ? (
            <p className="empty-state">Loading users…</p>
          ) : items.length === 0 ? (
            <p className="empty-state">No users found.</p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.display_name || item.username}</strong>
                        <small>@{item.username}</small>
                      </td>
                      <td>
                        <span className="role-code">
                          {item.role_code || "—"}
                        </span>
                        <small>{item.role_name}</small>
                      </td>
                      <td>
                        <span
                          className={`status-pill ${item.is_active ? "enabled" : "disabled"}`}
                        >
                          {item.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function RolesPage({ user, token }) {
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API}/api/roles`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "403 Forbidden — you do not have access to Roles."
            : data.detail || `Unable to load roles (HTTP ${response.status})`,
        );
      setRoles(data.roles || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  if (!loading && error.startsWith("403 Forbidden")) {
    return (
      <ForbiddenScreen
        message={
          error.replace(/^403 Forbidden\s*[—-]?\s*/i, "") ||
          "user do not have access."
        }
      />
    );
  }
  return (
    <main className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="admin-eyebrow">ACCESS CONTROL</p>
          <h1>Roles</h1>
          <p>Read-only view of roles currently configured in MongoDB.</p>
        </div>
        <button className="secondary-btn" onClick={load} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {error && <div className="notice error-notice">{error}</div>}
      <section className="admin-card roles-card">
        <div className="admin-card-title">
          <Shield size={19} />
          <div>
            <h2>Available roles</h2>
            <p>
              {roles.length} role{roles.length === 1 ? "" : "s"} found · Read
              only
            </p>
          </div>
        </div>
        {loading ? (
          <p className="empty-state">Loading roles…</p>
        ) : roles.length === 0 ? (
          <p className="empty-state">No roles found.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Role ID</th>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td>
                      <code>{role.id}</code>
                    </td>
                    <td>
                      <span className="role-code">{role.code}</span>
                    </td>
                    <td>
                      <strong>{role.name}</strong>
                    </td>
                    <td>
                      <span
                        className={`status-pill ${role.is_active ? "enabled" : "disabled"}`}
                      >
                        {role.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
