"use strict";
// Strips internal-only content from assistant text before it reaches the chat UI.
// Raw text (with everything intact) is still logged and still sent back as
// conversation history to the LLM — only the visible chat is sanitized.
//
// Removes:
//  - <think>…</think>, <thinking>…</thinking>, <reflection>…</reflection>,
//    <scratchpad>…</scratchpad>, <internal>…</internal> blocks
//  - lines prefixed with [internal] (one-line markers we may emit)
//  - leading "[Memory of past similar changes]" prefix the model sometimes echoes
//  - leading classification metadata "[request_type=…]"
//  - excessive blank lines created by stripping

const BLOCK_TAGS = ["think", "thinking", "reflection", "scratchpad", "internal", "scratch"];
const BLOCK_RE = new RegExp(
  `<(${BLOCK_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,
  "gi"
);
const ORPHAN_OPEN_RE = new RegExp(
  `<(${BLOCK_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`,
  "i"
);
const LEADING_INTERNAL_LINE_RE = /^\s*\[internal\][^\n]*\n?/gm;
const MEMORY_ECHO_RE =
  /^\s*\[Memory of past similar changes\][\s\S]*?(?:\n\s*\n|$)/i;
const REQUEST_TYPE_MARKER_RE = /^\s*\[request_type=[^\]]*\]\s*\n?/i;

function sanitizeAssistantText(input) {
  if (input === null || input === undefined) return input;
  let text = String(input);

  // strip well-formed thinking blocks first
  text = text.replace(BLOCK_RE, " ");

  // tolerate truncated / orphan opening tag (chat got cut mid-thinking)
  if (ORPHAN_OPEN_RE.test(text)) {
    text = text.replace(ORPHAN_OPEN_RE, "");
  }

  // strip leading echoed memory hint
  text = text.replace(MEMORY_ECHO_RE, "");

  // strip a leading [request_type=...] marker
  text = text.replace(REQUEST_TYPE_MARKER_RE, "");

  // remove any [internal] one-liners
  text = text.replace(LEADING_INTERNAL_LINE_RE, "");

  // collapse 3+ blank lines that the strip may have created
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// Walks an assistant content payload (string or rich-content array) and returns
// a sanitized COPY suitable for display. Original is not mutated.
function sanitizeAssistantContent(content) {
  if (typeof content === "string") {
    return sanitizeAssistantText(content);
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (item && typeof item === "object") {
        if (typeof item.text === "string") {
          return { ...item, text: sanitizeAssistantText(item.text) };
        }
        if (typeof item.content === "string") {
          return { ...item, content: sanitizeAssistantText(item.content) };
        }
      }
      return item;
    });
  }
  return content;
}

function isLikelyInternalSystemMessage(text) {
  const s = String(text || "");
  return (
    s.startsWith("[internal]") ||
    s.startsWith("[Memory of past similar changes]") ||
    s.startsWith("[request_type=")
  );
}

module.exports = {
  sanitizeAssistantText,
  sanitizeAssistantContent,
  isLikelyInternalSystemMessage,
};
