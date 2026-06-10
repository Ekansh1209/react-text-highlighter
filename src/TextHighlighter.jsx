import { useState, useRef, useCallback, useEffect } from "react";
import { PARAGRAPHS, themes } from "./GlobalConstant";

// Full plain text — paragraphs joined by newline for offset calculation
const FULL_TEXT = PARAGRAPHS.join("");

// Pre-compute where each paragraph starts in FULL_TEXT
const PARA_OFFSETS = PARAGRAPHS.reduce((acc, p, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + PARAGRAPHS[i - 1].length);
  return acc;
}, []);

// ─── ID helper ────────────────────────────────────────────────────────────────
let _id = 0;
const uid = () => `hl-${++_id}-${Date.now()}`;

// Walks text nodes inside `root` until it finds `targetNode`,
// then adds targetOffset to get the absolute character position.
function getTextOffset(root, targetNode, targetOffset) {
  let offset = 0;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    null,
    false,
  );
  while (walker.nextNode()) {
    if (walker.currentNode === targetNode) {
      return offset + targetOffset;
    }
    offset += walker.currentNode.textContent.length;
  }
  return offset;
}

// ───  Overlap resolver ─────────────────────────────────────────────────
function resolveOverlaps(existing, newHL) {
  const { start, end } = newHL;

  const filtered = existing.filter((h) => h.end <= start || h.start >= end);

  return [...filtered, newHL].sort((a, b) => a.start - b.start);
}

function mergeAdjacent(highlights) {
  const sorted = [...highlights].sort((a, b) => a.start - b.start);

  const merged = [];

  for (const h of sorted) {
    const last = merged[merged.length - 1];

    if (last && last.end >= h.start) {
      last.end = Math.max(last.end, h.end);
    } else {
      merged.push({ ...h });
    }
  }

  return merged;
}

// ─── Build segments for one paragraph ─────────────────────────────────
// paraStart = absolute offset where this paragraph begins in FULL_TEXT
// Returns [{ text, highlight: null | highlightObj }]
function buildSegments(paraText, paraStart, highlights) {
  const paraEnd = paraStart + paraText.length;

  // Only highlights that touch this paragraph
  const relevant = highlights
    .filter((h) => h.start < paraEnd && h.end > paraStart)
    .map((h) => ({
      ...h,
      // Clamp to paragraph boundaries
      start: Math.max(h.start, paraStart) - paraStart,
      end: Math.min(h.end, paraEnd) - paraStart,
    }))
    .sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = 0;

  for (const h of relevant) {
    if (cursor < h.start) {
      segments.push({ text: paraText.slice(cursor, h.start), highlight: null });
    }
    segments.push({ text: paraText.slice(h.start, h.end), highlight: h });
    cursor = h.end;
  }

  if (cursor < paraText.length) {
    segments.push({ text: paraText.slice(cursor), highlight: null });
  }

  return segments;
}

// ─── Main component ────────────────────────────────────────────────────────────
const HIGHLIGHTED_KEY = "text-highlighter-v1";

export default function TextHighlighter() {
  const [themeKey, setThemeKey] = useState(() => {
    try {
      return localStorage.getItem("theme") || "light";
    } catch {
      return "light";
    }
  });
  const [isHighlightMode, setIsHighlightMode] = useState(false);
  const [highlights, setHighlights] = useState(() => {
    // Load from localStorage on first mount
    try {
      const saved = localStorage.getItem(HIGHLIGHTED_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const articleRef = useRef(null);
  const t = themes[themeKey];

  // ─── Persist to localStorage whenever highlights change ─────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(HIGHLIGHTED_KEY, JSON.stringify(highlights));
    } catch {
      // localStorage unavailable (private browsing quota etc.) — fail silently
    }
  }, [highlights]);

  useEffect(() => {
    try {
      localStorage.setItem("theme", themeKey);
    } catch {
      // localStorage unavailable (private browsing quota etc.) — fail silently
    }
  }, [themeKey]);

  // ─── Escape key exits highlight mode ────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setIsHighlightMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ─── STEP 4: Handle mouse-up — capture selection, add highlight ──────────────
  const lastDoubleClickRef = useRef(0);
  const handleMouseUp = useCallback(
    (e) => {
      if (!isHighlightMode) return;

      if (Date.now() - lastDoubleClickRef.current < 300) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const range = selection.getRangeAt(0);
      const container = articleRef.current;

      if (!container || !container.contains(range.commonAncestorContainer))
        return;

      const start = getTextOffset(
        container,
        range.startContainer,
        range.startOffset,
      );

      const end = getTextOffset(container, range.endContainer, range.endOffset);

      if (start >= end || FULL_TEXT.slice(start, end).trim() === "") {
        selection.removeAllRanges();
        return;
      }

      const newHL = {
        id: uid(),
        start,
        end,
      };

      setHighlights((prev) => mergeAdjacent(resolveOverlaps(prev, newHL)));

      selection.removeAllRanges();
    },
    [isHighlightMode],
  );

  // ──── Remove on double-click ──────────────────────────────────────────
  const handleDoubleClick = useCallback(
    (e) => {
      const mark =
        e.target.nodeType === Node.TEXT_NODE
          ? e.target.parentElement?.closest("mark[data-hl-id]")
          : e.target.closest("mark[data-hl-id]");

      if (!mark) return;

      if (!isHighlightMode) return;

      e.preventDefault();

      const id = mark.getAttribute("data-hl-id");

      setHighlights((prev) => prev.filter((h) => h.id !== id));

      window.getSelection()?.removeAllRanges();
    },
    [isHighlightMode],
  );

  // ─── Reset all ───────────────────────────────────────────────────────────────
  const resetAll = useCallback(() => {
    setHighlights([]);
    setIsHighlightMode(false);
    try {
      localStorage.removeItem(HIGHLIGHTED_KEY);
    } catch {}
  }, []);

  // ───Render a paragraph with inline <mark> tags ─────────────────────
  const renderParagraph = (paraText, paraIndex) => {
    const paraStart = PARA_OFFSETS[paraIndex];
    const segments = buildSegments(paraText, paraStart, highlights);

    return (
      <p key={paraIndex} style={{ margin: "0 0 1.4rem", lineHeight: 1.8 }}>
        {segments.map((seg, i) => {
          if (!seg.highlight) {
            return <span key={i}>{seg.text}</span>;
          }
          const bg = themeKey === "light" ? "#ffe066" : "#b8860b";
          return (
            <mark
              key={i}
              data-hl-id={seg.highlight.id}
              title="Double-click to remove"
              style={{
                background: bg,
                color: "inherit",
                borderRadius: 3,
                padding: "1px 0",
                cursor: "pointer",
              }}
            >
              {seg.text}
            </mark>
          );
        })}
      </p>
    );
  };

  // ─── Inline styles ────────────────────────────────────────────────────────────
  const s = {
    root: {
      minHeight: "100vh",
      background: t.bg,
      color: t.text,
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      transition: "background 0.2s, color 0.2s",
    },
    toolbar: {
      position: "sticky",
      top: 0,
      zIndex: 100,
      background: t.toolbar,
      borderBottom: `1px solid ${t.toolbarBorder}`,
      padding: "10px 20px",
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap",
    },
    logo: {
      fontWeight: 700,
      fontSize: 15,
      letterSpacing: "-0.02em",
      color: t.text,
      marginRight: 4,
    },
    divider: {
      width: 1,
      height: 24,
      background: t.border,
      margin: "0 2px",
      flexShrink: 0,
    },
    spacer: { flex: 1 },
    btn: (variant = "secondary", active = false, disabled = false) => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "5px 12px",
      fontSize: 13,
      fontWeight: 500,
      border: `1px solid ${variant === "primary" ? "transparent" : t.border}`,
      borderRadius: 7,
      cursor: disabled ? "not-allowed" : "pointer",
      transition: "all 0.15s",
      opacity: disabled ? 0.4 : 1,
      background: active
        ? t.btnPrimary
        : variant === "primary"
          ? t.btnPrimary
          : variant === "danger"
            ? t.btnDanger
            : t.btnSecondary,
      color: active
        ? t.btnPrimaryText
        : variant === "primary"
          ? t.btnPrimaryText
          : variant === "danger"
            ? t.btnDangerText
            : t.btnSecondaryText,
    }),
    highlightCount: {
      fontSize: 12,
      color: t.textMuted,
      padding: "3px 8px",
      background: t.badge,
      borderRadius: 99,
      whiteSpace: "nowrap",
    },
    modeIndicator: {
      fontSize: 12,
      fontWeight: 500,
      padding: "3px 10px",
      borderRadius: 99,
      whiteSpace: "nowrap",
      transition: "all 0.2s",
      background: isHighlightMode
        ? themeKey === "light"
          ? "#dcfce7"
          : "#14532d"
        : t.badge,
      color: isHighlightMode
        ? themeKey === "light"
          ? "#15803d"
          : "#86efac"
        : t.textMuted,
    },
    content: {
      maxWidth: 740,
      margin: "0 auto",
      padding: "40px 24px",
    },
    tip: {
      marginBottom: 16,
      padding: "9px 16px",
      background: t.tip.bg,
      border: `1px solid ${t.tip.border}`,
      borderRadius: 8,
      fontSize: 13,
      color: t.tip.text,
    },
    article: {
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      padding: "36px 40px",
      fontSize: 17,
      lineHeight: 1.8,
      // Only allow text selection when highlight mode is on
      userSelect: isHighlightMode ? "text" : "none",
      cursor: isHighlightMode ? "text" : "default",
      // Color ring matches active highlight color
      outline: isHighlightMode ? "2px solid #ffe066" : "none",
      transition: "outline 0.2s",
    },
  };

  return (
    <div style={s.root}>
      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div style={s.toolbar}>
        <span style={s.logo}>✦ Highlighter</span>

        {/* Mode toggle */}
        <button
          style={s.btn("primary", isHighlightMode)}
          onClick={() => setIsHighlightMode((m) => !m)}
          title={
            isHighlightMode
              ? "Click to stop highlighting (Esc)"
              : "Click then select text to highlight"
          }
        >
          {isHighlightMode ? "✦ On" : "◇ Highlight"}
        </button>

        <span style={s.modeIndicator}>
          {isHighlightMode ? "select text to highlight" : "mode off"}
        </span>

        <div style={s.divider} />

        <div style={s.spacer} />

        {/* Highlight count */}
        <span style={s.highlightCount}>
          {highlights.length} highlight{highlights.length !== 1 ? "s" : ""}
        </span>

        {/* Reset */}
        <button
          style={s.btn("danger", false, highlights.length === 0)}
          onClick={resetAll}
          disabled={highlights.length === 0}
          title="Clear all highlights"
        >
          ✕ Reset
        </button>

        {/* Theme */}
        <button
          style={s.btn()}
          onClick={() => setThemeKey((k) => (k === "light" ? "dark" : "light"))}
        >
          {themeKey === "light" ? "☽ Dark" : "☀ Light"}
        </button>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div style={s.content}>
        {/* Tip banner */}
        {isHighlightMode && (
          <div style={s.tip}>
            💡 Drag to highlight text. <strong>Double-click</strong> any
            highlight to remove it. Press <kbd>Esc</kbd> to exit.
          </div>
        )}

        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            marginBottom: 24,
            lineHeight: 1.3,
            letterSpacing: "-0.03em",
            color: themeKey === "light" ? "#333" : "#ddd",
          }}
        >
          Typography
        </h1>

        {/* Article */}
        <article
          ref={articleRef}
          style={s.article}
          onMouseUp={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onTouchEnd={handleMouseUp} // basic mobile support
        >
          {/* Render each paragraph with inline highlights */}
          {PARAGRAPHS.map((para, i) => renderParagraph(para, i))}
        </article>

        {/* Persistence note */}
        <p
          style={{
            fontSize: 12,
            color: t.textMuted,
            marginTop: 12,
            textAlign: "center",
          }}
        >
          Highlights are saved automatically and will persist on refresh.
        </p>
      </div>
    </div>
  );
}
