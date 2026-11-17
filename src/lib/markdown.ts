import hljs from "highlight.js/lib/common";
import katex from "katex";
import { Marked, type TokenizerAndRendererExtension } from "marked";

function tex(src: string, displayMode: boolean) {
  return katex.renderToString(src, { displayMode, throwOnError: false, strict: "ignore", trust: false });
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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function highlight(code: string, language?: string) {
  const lang = language && hljs.getLanguage(language) ? language : undefined;
  return lang ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [blockMath, inlineMath],
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
});

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
