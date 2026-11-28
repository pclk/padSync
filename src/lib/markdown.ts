import hljs from "highlight.js/lib/common";
import katex from "katex";
import { Marked, type MarkedExtension, type TokenizerAndRendererExtension } from "marked";
import { widgetDocument } from "./widget";

// Markdown for AI answers and notebook blocks, with LaTeX and the colour vocabulary the AI is
// taught (bridge/lib.ts FORMAT_GUIDE): coloured text `[text]{.red}`, highlighter `[text]{.hl-yellow}`,
// coloured maths `\red{x}`, and callout boxes `:::tip Title … :::`. Colours are theme-aware classes
// (globals.css), never inline styles. The chat also runs ```interactive blocks (renderChatMarkdown).

/** The colours an answer may use; each is a class (md-c-*, md-hl-*) with light and dark values. */
export const MD_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"] as const;
const COLOR_SET = new Set<string>(MD_COLORS);
/** Callout kinds, with the title shown when none is given. */
export const CALLOUTS: Record<string, string> = {
  note: "Note",
  key: "Key idea",
  definition: "Definition",
  tip: "Tip",
  example: "Example",
  warn: "Watch out",
  mistake: "Common mistake",
};

// `\red{x}` and friends colour maths with the same classes as text, so a term keeps its colour
// in prose and in equations. Only that class may be set: KaTeX trusts nothing else.
const COLOR_MACROS = Object.fromEntries(MD_COLORS.map((c) => [`\\${c}`, `\\htmlClass{md-c-${c}}{#1}`]));
const trustColour = (ctx: { command: string; class?: string }) => ctx.command === "\\htmlClass" && /^md-c-[a-z]+$/.test(ctx.class ?? "");

function tex(src: string, displayMode: boolean) {
  return katex.renderToString(src, { displayMode, throwOnError: false, strict: "ignore", trust: trustColour, macros: { ...COLOR_MACROS } });
}

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => src.match(/\$\$|\\\[/)?.index,
  tokenizer(src) {
    const m = src.match(/^\$\$([\s\S]+?)\$\$/) ?? src.match(/^\\\[([\s\S]+?)\\\]/);
    if (m) return { type: "blockMath", raw: m[0], text: m[1].trim() };
  },
  renderer: (token) => `<div class="math-block">${tex(token.text, true)}</div>`,
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => src.match(/\$|\\\(/)?.index,
  tokenizer(src) {
    const m = src.match(/^\$\$([\s\S]+?)\$\$/) ?? src.match(/^\$((?:\\\$|[^$\n])+?)\$/) ?? src.match(/^\\\(([\s\S]+?)\\\)/);
    if (m) return { type: "inlineMath", raw: m[0], text: m[1], display: m[0].startsWith("$$") };
  },
  renderer: (token) => tex(token.text, !!token.display),
};

/** `[text]{.red}` colours text, `[text]{.hl-yellow}` highlights it; markdown inside still works. */
const colorSpan: TokenizerAndRendererExtension = {
  name: "colorSpan",
  level: "inline",
  start: (src) => src.match(/\[[^\]\n]*\]\{\./)?.index,
  tokenizer(src) {
    const m = src.match(/^\[((?:\\.|[^\]\\\n])+)\]\{\.(hl-)?([a-z]+)\}/);
    if (!m || !COLOR_SET.has(m[3])) return;
    return { type: "colorSpan", raw: m[0], cls: `md-${m[2] ? "hl" : "c"}-${m[3]}`, tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(token) {
    return `<span class="${token.cls}">${this.parser.parseInline(token.tokens ?? [])}</span>`;
  },
};

/** `:::tip Optional title` … `:::`, a tinted box. Unclosed (an answer still streaming) it runs to the end. */
const callout: TokenizerAndRendererExtension = {
  name: "callout",
  level: "block",
  start: (src) => src.match(/^:::[a-z]/m)?.index,
  tokenizer(src) {
    const m = src.match(/^:::([a-z]+)[ \t]*([^\n]*)\n([\s\S]*?)(?:\n:::[ \t]*(?:\n+|$)|$)/);
    if (!m || !(m[1] in CALLOUTS)) return;
    return { type: "callout", raw: m[0], kind: m[1], title: this.lexer.inlineTokens(m[2].trim() || CALLOUTS[m[1]]), tokens: this.lexer.blockTokens(m[3], []) };
  },
  renderer(token) {
    return `<div class="md-callout md-callout-${token.kind}"><p class="md-callout-title">${this.parser.parseInline(token.title)}</p>${this.parser.parse(token.tokens ?? [])}</div>`;
  },
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function highlight(code: string, language?: string) {
  const lang = language && hljs.getLanguage(language) ? language : undefined;
  return lang ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
}

const BASE: MarkedExtension = {
  extensions: [blockMath, inlineMath, colorSpan, callout],
  renderer: {
    // Payloads come from pasted AI output: never pass raw HTML through.
    html: ({ text }) => escapeHtml(text),
    code: ({ text, lang }) => `<pre class="hljs"><code>${highlight(text, lang)}</code></pre>`,
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      return /^https?:/.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>` : label;
    },
    image: ({ href, text }) => (/^(https:|data:image\/)/.test(href) ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">` : ""),
  },
};
const marked = new Marked({ gfm: true, breaks: false }, BASE);

/**
 * The chat's markdown: as renderMarkdown, plus ```interactive blocks run as a small page in a
 * sandboxed frame (src/lib/widget.ts; Message.tsx sizes it and passes the theme). A block still
 * being written shows as a placeholder, so a half-written script never runs.
 */
const chatMarked = new Marked({ gfm: true, breaks: false }, BASE, {
  renderer: {
    code({ text, lang, raw }) {
      const info = (lang ?? "").trim();
      if (!/^interactive\b/.test(info)) return false;
      const title = info.slice("interactive".length).trim() || "Interactive";
      const closed = /\n[ \t]*(`{3,}|~{3,})[ \t]*\n*$/.test(raw);
      if (!closed) return `<div class="chat-widget chat-widget-pending" role="status"><span class="chat-widget-title">${escapeHtml(title)}</span> Building…</div>`;
      return (
        `<figure class="chat-widget" data-widget>` +
        `<figcaption><span class="chat-widget-title">${escapeHtml(title)}</span>` +
        `<button type="button" data-widget-action="reload" title="Start it again">Reset</button>` +
        `<button type="button" data-widget-action="code" aria-expanded="false" title="Show the code">Code</button></figcaption>` +
        `<iframe sandbox="allow-scripts" title="${escapeHtml(title)}" srcdoc="${escapeHtml(widgetDocument(text))}"></iframe>` +
        `<pre class="hljs chat-widget-source" hidden><code>${highlight(text, "html")}</code></pre>` +
        `</figure>`
      );
    },
  },
});

const chatCache = new Map<string, string>();

export function renderChatMarkdown(src: string): string {
  let html = chatCache.get(src);
  if (html === undefined) {
    html = chatMarked.parse(src, { async: false }) as string;
    if (chatCache.size > 500) chatCache.clear();
    chatCache.set(src, html);
  }
  return html;
}

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  let html = cache.get(src);
  if (html === undefined) {
    html = marked.parse(src, { async: false }) as string;
    if (cache.size > 500) cache.clear();
    cache.set(src, html);
  }
  return html;
}

const inlineCache = new Map<string, string>();

/** Markdown + LaTeX without the surrounding paragraph, for text inside a line (cloze answers). */
export function renderInline(src: string): string {
  let html = inlineCache.get(src);
  if (html === undefined) {
    html = marked.parseInline(src, { async: false }) as string;
    if (inlineCache.size > 500) inlineCache.clear();
    inlineCache.set(src, html);
  }
  return html;
}
