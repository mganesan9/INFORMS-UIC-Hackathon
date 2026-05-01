import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ChatAgent } from "./server";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  GearIcon,
  XIcon,
  PaperclipIcon,
  ImageIcon,
  UserIcon,
  ChartBarIcon,
} from "@phosphor-icons/react";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

// ── Attachment helpers ──────────────────────────────────────────────────

interface Attachment {
  id: string;
  file: File;
  preview: string;
  mediaType: string;
}

function createAttachment(file: File): Attachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    preview: URL.createObjectURL(file),
    mediaType: file.type || "application/octet-stream",
  };
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Extract patient names from markdown table rows ──────────────────────
// Looks for the first column of any markdown table row that looks like a name
function extractPatientNames(markdown: string): string[] {
  const names: string[] = [];
  const rows = markdown.split("\n");
  let inTable = false;
  let headerParsed = false;

  for (const row of rows) {
    if (!row.trim().startsWith("|")) { inTable = false; headerParsed = false; continue; }
    inTable = true;
    // Skip separator rows like |---|---|
    if (/^\|[\s\-|:]+\|$/.test(row.trim())) continue;
    const cells = row.split("|").map(c => c.trim()).filter(Boolean);
    if (!headerParsed) {
      // First real row — check if first col header is "Name" or similar
      const firstHeader = cells[0]?.toLowerCase() ?? "";
      headerParsed = true;
      if (firstHeader === "#" || firstHeader === "name" || firstHeader === "patient") continue;
      // Not a header row — treat as data
    }
    if (!inTable) continue;
    const firstName = cells[0];
    // Must look like "Firstname Lastname" (two words, letters only, 4+ chars each)
    if (firstName && /^[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(firstName) && !names.includes(firstName)) {
      names.push(firstName);
    }
  }
  return names;
}

// ── Render markdown with clickable patient names ─────────────────────────
function InteractiveMarkdown({
  text,
  onPatientClick,
  isAnimating,
}: {
  text: string;
  onPatientClick: (name: string) => void;
  isAnimating: boolean;
}) {
  const patientNames = extractPatientNames(text);

  if (patientNames.length === 0) {
    return (
      <Streamdown
        className="chase-md sd-theme"
        plugins={{ code }}
        controls={false}
        isAnimating={isAnimating}
      >
        {text}
      </Streamdown>
    );
  }

  // Post-process: replace patient names in table cells with clickable buttons
  // We render via Streamdown first (in a hidden div), then patch the DOM
  return (
    <ClickableTableWrapper text={text} patientNames={patientNames} onPatientClick={onPatientClick} isAnimating={isAnimating} />
  );
}

function ClickableTableWrapper({
  text,
  patientNames,
  onPatientClick,
  isAnimating,
}: {
  text: string;
  patientNames: string[];
  onPatientClick: (name: string) => void;
  isAnimating: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || isAnimating) return;
    const tds = containerRef.current.querySelectorAll("td");
    tds.forEach((td) => {
      const name = patientNames.find(n => td.textContent?.trim() === n);
      if (name && !td.querySelector("button")) {
        const btn = document.createElement("button");
        btn.className = "chase-patient-link";
        btn.textContent = name;
        btn.title = `View cost analysis for ${name}`;
        btn.onclick = () => onPatientClick(name);
        td.innerHTML = "";
        td.appendChild(btn);
      }
    });
  }, [text, patientNames, onPatientClick, isAnimating]);

  return (
    <div ref={containerRef}>
      <Streamdown
        className="chase-md sd-theme"
        plugins={{ code }}
        controls={false}
        isAnimating={isAnimating}
      >
        {text}
      </Streamdown>
    </div>
  );
}

// ── Tool card ─────────────────────────────────────────────────────────────

function ToolCard({
  part,
  addToolApprovalResponse,
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (r: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const [expanded, setExpanded] = useState(false);

  if (part.state === "output-available") {
    return (
      <div className="chase-tool-card" style={{ marginBottom: 4 }}>
        <div className="chase-tool-card-header">
          <GearIcon size={13} color="var(--chase-navy)" />
          <span className="chase-tool-name">{toolName}</span>
          <span className="chase-tool-badge chase-tool-badge-done">Done</span>
          <button
            className="chase-icon-btn"
            style={{ marginLeft: "auto", fontSize: 11 }}
            onClick={() => setExpanded(e => !e)}
          >
            <CaretDownIcon size={12} style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 0.2s" }} />
          </button>
        </div>
        {expanded && (
          <pre style={{ fontSize: 11, color: "var(--chase-muted)", marginTop: 6, fontFamily: "'DM Mono', monospace", overflow: "auto", maxHeight: 160 }}>
            {JSON.stringify(part.output, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="chase-approval-card" style={{ marginBottom: 4 }}>
        <div className="chase-tool-card-header">
          <GearIcon size={13} color="var(--chase-gold)" />
          <span className="chase-tool-name">Approval needed: {toolName}</span>
        </div>
        <pre style={{ fontSize: 11, color: "var(--chase-muted)", marginBottom: 8, fontFamily: "'DM Mono', monospace", overflow: "auto", maxHeight: 100 }}>
          {JSON.stringify((part as { input?: unknown }).input, null, 2)}
        </pre>
        <div className="chase-approval-actions">
          <button className="chase-approve-btn" onClick={() => approvalId && addToolApprovalResponse({ id: approvalId, approved: true })}>
            <CheckCircleIcon size={13} style={{ marginRight: 4 }} />Approve
          </button>
          <button className="chase-reject-btn" onClick={() => approvalId && addToolApprovalResponse({ id: approvalId, approved: false })}>
            <XCircleIcon size={13} style={{ marginRight: 4 }} />Reject
          </button>
        </div>
      </div>
    );
  }

  if (part.state === "output-denied") {
    return (
      <div className="chase-tool-card" style={{ marginBottom: 4 }}>
        <div className="chase-tool-card-header">
          <XCircleIcon size={13} color="var(--chase-danger)" />
          <span className="chase-tool-name">{toolName}</span>
          <span className="chase-tool-badge chase-tool-badge-rejected">Rejected</span>
        </div>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="chase-tool-card" style={{ marginBottom: 4 }}>
        <div className="chase-tool-card-header">
          <GearIcon size={13} color="var(--chase-navy)" style={{ animation: "spin 1s linear infinite" }} />
          <span className="chase-tool-name" style={{ color: "var(--chase-muted)" }}>Running {toolName}…</span>
        </div>
      </div>
    );
  }

  return null;
}

// ── Patient detail panel ─────────────────────────────────────────────────

function PatientPanel({
  patientName,
  content,
  loading,
  onClose,
}: {
  patientName: string;
  content: string;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="chase-panel">
      <div className="chase-panel-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <UserIcon size={16} color="var(--chase-gold)" />
            <span className="chase-panel-title">{patientName}</span>
          </div>
          <div className="chase-panel-subtitle">Cost Analysis</div>
        </div>
        <button className="chase-panel-close" onClick={onClose} aria-label="Close panel">
          <XIcon size={14} />
        </button>
      </div>

      <div className="chase-panel-body">
        {loading ? (
          <div className="chase-panel-loading">
            <div className="chase-spinner" />
            <span>Running cost analysis…</span>
          </div>
        ) : (
          <Streamdown className="chase-md sd-theme" plugins={{ code }} controls={false} isAnimating={false}>
            {content}
          </Streamdown>
        )}
      </div>
    </div>
  );
}

// ── Theme toggle ─────────────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <button className="chase-hdr-icon-btn" onClick={toggle} aria-label="Toggle theme">
      {dark ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </button>
  );
}

// ── Main chat ─────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "Top 10 most expensive patients",
  "Who has the most ED visits?",
  "Tell me about Giovanni Paucek",
  "Analyze Soledad White",
];

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toasts = useKumoToastManager();

  // Patient detail panel state
  const [panelPatient, setPanelPatient] = useState<string | null>(null);
  const [panelContent, setPanelContent] = useState("");
  const [panelLoading, setPanelLoading] = useState(false);

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback((e: Event) => console.error("WebSocket error:", e), []),
    onMessage: useCallback((message: MessageEvent) => {
      try {
        const data = JSON.parse(String(message.data));
        if (data.type === "scheduled-task") {
          toasts.add({ title: "Scheduled task completed", description: data.description, timeout: 0 });
        }
      } catch { /* not our event */ }
    }, [toasts]),
  });

  const { messages, sendMessage, clearHistory, addToolApprovalResponse, stop, status } = useAgentChat({
    agent,
    onToolCall: async (event) => {
      if ("addToolOutput" in event && event.toolCall.toolName === "getUserTimezone") {
        event.addToolOutput({
          toolCallId: event.toolCall.toolCallId,
          output: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, localTime: new Date().toLocaleTimeString() },
        });
      }
    },
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { if (!isStreaming && textareaRef.current) textareaRef.current.focus(); }, [isStreaming]);

  // Watch for panel analysis responses coming back as the last assistant message
  useEffect(() => {
    if (!panelLoading || !panelPatient) return;
    if (isStreaming) return;
    // Find the last assistant message — it should be the cost analysis
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    if (!lastAssistant) return;
    const text = lastAssistant.parts.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("");
    if (text && text.includes("Cost Driver")) {
      setPanelContent(text);
      setPanelLoading(false);
    }
  }, [isStreaming, messages, panelLoading, panelPatient]);

  const handlePatientClick = useCallback((name: string) => {
    setPanelPatient(name);
    setPanelContent("");
    setPanelLoading(true);
    sendMessage({ role: "user", parts: [{ type: "text", text: `Analyze ${name}` }] });
  }, [sendMessage]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setAttachments(prev => [...prev, ...images.map(createAttachment)]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const att = prev.find(a => a.id === id);
      if (att) URL.revokeObjectURL(att.preview);
      return prev.filter(a => a.id !== id);
    });
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;
    setInput("");
    const parts: Array<{ type: "text"; text: string } | { type: "file"; mediaType: string; url: string }> = [];
    if (text) parts.push({ type: "text", text });
    for (const att of attachments) {
      const dataUri = await fileToDataUri(att.file);
      parts.push({ type: "file", mediaType: att.mediaType, url: dataUri });
    }
    for (const att of attachments) URL.revokeObjectURL(att.preview);
    setAttachments([]);
    sendMessage({ role: "user", parts });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, attachments, isStreaming, sendMessage]);

  return (
    <div
      className="chase-app"
      onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes("Files")) setIsDragging(true); }}
      onDragLeave={e => { e.preventDefault(); if (e.currentTarget === e.target) setIsDragging(false); }}
      onDrop={e => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files); }}
    >
      {isDragging && (
        <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,48,135,0.12)", backdropFilter: "blur(4px)", border: "2px dashed var(--chase-navy)", borderRadius: 12, margin: 8, pointerEvents: "none" }}>
          <div style={{ textAlign: "center", color: "var(--chase-navy)" }}>
            <ImageIcon size={36} />
            <div style={{ marginTop: 8, fontWeight: 600 }}>Drop images here</div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="chase-header">
        <div className="chase-header-logo">
          <ChartBarIcon size={22} color="var(--chase-gold)" weight="fill" />
          <div>
            <div className="chase-header-title">Care Analytics</div>
            <div className="chase-header-subtitle">Healthcare Cost Intelligence</div>
          </div>
        </div>
        <div className="chase-header-actions">
          <div className="chase-status">
            <div className={`chase-status-dot ${connected ? "chase-status-dot-on" : "chase-status-dot-off"}`} />
            {connected ? "Connected" : "Disconnected"}
          </div>
          <ThemeToggle />
          <button
            className="chase-hdr-btn"
            onClick={() => setShowDebug(d => !d)}
            title="Toggle debug"
          >
            {showDebug ? "Hide Debug" : "Debug"}
          </button>
          <button
            className="chase-hdr-btn"
            onClick={clearHistory}
            title="Clear history"
          >
            <TrashIcon size={13} />
            Clear
          </button>
        </div>
      </header>

      {/* Main: chat + optional panel */}
      <div className="chase-main">
        <div className="chase-chat-col">
          {/* Messages */}
          <div className="chase-messages">
            <div className="chase-messages-inner">
              {messages.length === 0 && (
                <div className="chase-empty">
                  <ChartBarIcon size={48} className="chase-empty-icon" weight="duotone" />
                  <div className="chase-empty-title">Healthcare Cost Analytics</div>
                  <div className="chase-empty-subtitle">Ask about patient costs, find high-risk patients, or drill into individual cost drivers.</div>
                  <div className="chase-suggestion-chips">
                    {SUGGESTIONS.map(s => (
                      <button key={s} className="chase-chip" disabled={isStreaming} onClick={() => sendMessage({ role: "user", parts: [{ type: "text", text: s }] })}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLastAssistant = message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {showDebug && (
                      <pre className="chase-debug-pre">{JSON.stringify(message, null, 2)}</pre>
                    )}

                    {/* Tool parts */}
                    {message.parts.filter(isToolUIPart).map(part => (
                      <ToolCard key={part.toolCallId} part={part} addToolApprovalResponse={addToolApprovalResponse} />
                    ))}

                    {/* Reasoning */}
                    {message.parts
                      .filter(p => p.type === "reasoning" && (p as { text?: string }).text?.trim())
                      .map((p, i) => {
                        const r = p as { type: "reasoning"; text: string; state?: "streaming" | "done" };
                        const done = r.state === "done" || !isStreaming;
                        return (
                          <details key={i} className="chase-reasoning" open={!done}>
                            <summary>
                              <BrainIcon size={13} color="#7c5cbf" />
                              <span>Reasoning</span>
                              <span style={{ fontSize: 11, color: done ? "var(--chase-success)" : "var(--chase-navy)", marginLeft: 4 }}>
                                {done ? "Complete" : "Thinking…"}
                              </span>
                              <CaretDownIcon size={12} style={{ marginLeft: "auto", color: "var(--chase-muted)" }} />
                            </summary>
                            <pre>{r.text}</pre>
                          </details>
                        );
                      })}

                    {/* Image parts */}
                    {message.parts
                      .filter((p): p is Extract<typeof p, { type: "file" }> => p.type === "file" && (p as { mediaType?: string }).mediaType?.startsWith("image/") === true)
                      .map((p, i) => (
                        <div key={`img-${i}`} className={isUser ? "chase-bubble-user" : "chase-bubble-assistant"}>
                          <img src={p.url} alt="Attachment" style={{ maxHeight: 240, borderRadius: 10, border: "1px solid var(--chase-border)", objectFit: "contain" }} />
                        </div>
                      ))}

                    {/* Text parts */}
                    {message.parts
                      .filter(p => p.type === "text")
                      .map((p, i) => {
                        const text = (p as { type: "text"; text: string }).text;
                        if (!text) return null;
                        if (isUser) {
                          return (
                            <div key={i} className="chase-bubble-user">
                              <div className="chase-bubble-user-inner">{text}</div>
                            </div>
                          );
                        }
                        return (
                          <div key={i} className="chase-bubble-assistant">
                            <div className="chase-bubble-assistant-inner">
                              <InteractiveMarkdown
                                text={text}
                                onPatientClick={handlePatientClick}
                                isAnimating={isLastAssistant && isStreaming}
                              />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="chase-input-bar">
            <input ref={fileInputRef} type="file" multiple accept="image/*" className="hidden" onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />

            {attachments.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", maxWidth: 780, margin: "0 auto 8px" }}>
                {attachments.map(att => (
                  <div key={att.id} style={{ position: "relative" }}>
                    <img src={att.preview} alt={att.file.name} style={{ height: 56, width: 56, objectFit: "cover", borderRadius: 8, border: "1px solid var(--chase-border)" }} />
                    <button type="button" onClick={() => removeAttachment(att.id)} style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.6)", border: "none", color: "#fff", borderRadius: "50%", width: 16, height: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                      <XIcon size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={e => { e.preventDefault(); send(); }}>
              <div className="chase-input-inner" style={{ maxWidth: 780, margin: "0 auto" }}>
                <button type="button" className="chase-icon-btn" onClick={() => fileInputRef.current?.click()} disabled={!connected || isStreaming} title="Attach image">
                  <PaperclipIcon size={17} />
                </button>
                <textarea
                  ref={textareaRef}
                  className="chase-textarea"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  onInput={e => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }}
                  placeholder={attachments.length > 0 ? "Add a message or send…" : "Ask about patient costs, find high-risk patients…"}
                  disabled={!connected || isStreaming}
                  rows={1}
                />
                {isStreaming ? (
                  <button type="button" className="chase-stop-btn" onClick={stop} title="Stop">
                    <StopIcon size={16} />
                  </button>
                ) : (
                  <button type="submit" className="chase-send-btn" disabled={(!input.trim() && attachments.length === 0) || !connected} title="Send">
                    <PaperPlaneRightIcon size={16} />
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        {/* Patient detail panel */}
        {panelPatient && (
          <PatientPanel
            patientName={panelPatient}
            content={panelContent}
            loading={panelLoading}
            onClose={() => { setPanelPatient(null); setPanelContent(""); }}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense fallback={<div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--chase-muted)", fontFamily: "'DM Sans', sans-serif" }}>Loading…</div>}>
        <Chat />
      </Suspense>
    </Toasty>
  );
}
