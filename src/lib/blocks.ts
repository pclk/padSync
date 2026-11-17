import type { Block } from "./types";

// Plain-text (Markdown) form of the study blocks, for the Ask AI bundle and copied section text.
// Image and space blocks are handled by the callers (they depend on what is being exported).
// Hidden answers (cloze blanks, recall answers, hidden reasons) are only written when `answers` is
// set, marked as hidden from the student, like reference solutions.

export const CLOZE_RE = /\{\{([^{}]+)\}\}/g;

/** Splits cloze text into text and blank parts. */
export function clozeParts(text: string): { text: string; blank: boolean }[] {
  const out: { text: string; blank: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(CLOZE_RE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), blank: false });
    out.push({ text: m[1].trim(), blank: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), blank: false });
  return out;
}

const label = (s: string) => s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function studyBlockMarkdown(b: Block, answers: boolean): string | null {
  switch (b.type) {
    case "callout":
      return `> **${b.title ? `${label(b.style)}: ${b.title}` : label(b.style)}**\n>\n${b.text.split("\n").map((l) => `> ${l}`).join("\n")}`;
    case "steps": {
      const lines = [b.title ? `**${b.title}**` : null, b.problem ? `Problem: ${b.problem}` : null];
      b.steps.forEach((s, i) => {
        const why = s.why ? (b.blankWhy ? (answers ? ` _(why, hidden from student: ${s.why})_` : " _(why: ____)_") : ` _(${s.why})_`) : b.blankWhy ? " _(why: ____)_" : "";
        lines.push(`${i + 1}. ${s.text}${why}`);
      });
      if (b.result) lines.push(`Result: ${b.result}`);
      return lines.filter(Boolean).join("\n");
    }
    case "glossary":
      return [b.title ? `**${b.title}**` : "**Glossary**", ...b.terms.map((t) => `- **${t.term}**: ${b.hideDefinitions && !answers ? "____" : t.definition}${t.example ? ` (e.g. ${t.example})` : ""}`)].join("\n");
    case "conceptMap": {
      const name = new Map(b.nodes.map((n) => [n.id, n.label]));
      return [
        b.title ? `**${b.title}** (concept map)` : "**Concept map**",
        ...b.nodes.map((n) => `- ${n.label}${n.note ? `: ${n.note}` : ""}`),
        ...b.links.map((l) => `- ${name.get(l.from) ?? l.from} → ${l.label ? `${l.label} → ` : ""}${name.get(l.to) ?? l.to}`),
      ].join("\n");
    }
    case "cloze":
      return clozeParts(b.text).map((p) => (p.blank ? (answers ? `[blank, hidden from student: ${p.text}]` : "____") : p.text)).join("") + (b.hint ? `\n_Hint: ${b.hint}_` : "");
    case "recall":
      return [b.title ? `**${b.title}**` : "**Recall**", ...b.items.map((it, i) => `${i + 1}. ${it.q}${answers && it.a ? `\n   _Answer (hidden from student): ${it.a}_` : ""}`)].join("\n");
    case "rewrite":
      return `**${b.prompt ?? "Rewrite in your own words"}**\n\n> ${b.text.split("\n").join("\n> ")}`;
    case "prompt":
      return `**✎ ${b.text}**`;
    case "checkpoint":
      return [b.title ? `**${b.title}**` : "**Checkpoint**", ...b.items.map((it) => `- [ ] ${it}`)].join("\n");
    default:
      return null;
  }
}

export const MASK = "…";

/** The block with its hidden answers blanked, for exports that leave solutions out. */
export function maskAnswers(b: Block): Block {
  switch (b.type) {
    case "cloze":
      return { ...b, text: b.text.replace(CLOZE_RE, `{{${MASK}}}`) };
    case "recall":
      return { ...b, items: b.items.map((it) => ({ q: it.q, ...(it.space !== undefined ? { space: it.space } : {}) })) };
    case "steps":
      return b.blankWhy ? { ...b, steps: b.steps.map((s) => ({ text: s.text })) } : b;
    case "glossary":
      return b.hideDefinitions ? { ...b, terms: b.terms.map((t) => ({ ...t, definition: MASK })) } : b;
    default:
      return b;
  }
}

/** True when the block hides something from the student until revealed. */
export function hasHiddenAnswers(b: Block): boolean {
  return b.type === "cloze" || (b.type === "recall" && b.items.some((i) => i.a)) || (b.type === "steps" && !!b.blankWhy && b.steps.some((s) => s.why)) || (b.type === "glossary" && !!b.hideDefinitions);
}
