// The page an AI's ```interactive block runs in (markdown.ts renderChatMarkdown): its HTML, CSS
// and JS inside a ready-made document, shown in an iframe sandboxed to scripts only, so it can't
// reach the app, its storage or cookies. Its content security policy also keeps it off the
// network, apart from loading a library from a few CDNs. Message.tsx sizes the frame to what
// the page reports and tells it the theme; the page styles itself from the variables here.

/** Messages between the frame and the chat. */
export const WIDGET_HEIGHT = "padsync-widget-height";
export const WIDGET_THEME = "padsync-widget-theme";
/** The tallest a frame grows before its page scrolls. */
export const WIDGET_MAX_HEIGHT = 1400;

const CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com";
const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS}`,
  `font-src data: ${CDNS}`,
  "img-src data: blob:",
  "media-src data: blob:",
].join("; ");

// The palette matches the chat's colour classes (globals.css md-c-*), light and dark.
const STYLE = `
:root{color-scheme:light;--fg:#0f172a;--muted:#64748b;--border:#e2e8f0;--surface:#f8fafc;--surface-2:#f1f5f9;--accent:#4a6cf7;--on-accent:#fff;
--red:#d92d20;--orange:#e8590c;--yellow:#b08800;--green:#2f9e44;--teal:#0c8599;--blue:#1c7ed6;--purple:#7048e8;--pink:#d6336c;--gray:#6b7280}
:root[data-theme=dark]{color-scheme:dark;--fg:#e6e9ef;--muted:#8a95a6;--border:#2d3542;--surface:#0b0d11;--surface-2:#161b23;--accent:#7b93ff;--on-accent:#0b0d11;
--red:#ff6b6b;--orange:#ff922b;--yellow:#ffd43b;--green:#51cf66;--teal:#3bc9db;--blue:#4dabf7;--purple:#b197fc;--pink:#f783ac;--gray:#9ca3af}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
body{padding:12px}
button,select,input,textarea{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--border);background:var(--surface-2);border-radius:8px;padding:4px 12px}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
input[type=range]{accent-color:var(--accent);vertical-align:middle}
input:not([type=range]):not([type=checkbox]):not([type=radio]),select,textarea{border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:4px 8px}
canvas,svg,img{max-width:100%}
label{display:inline-flex;align-items:center;gap:6px}
`;

const SCRIPT = `
(function(){
  var last=0;
  function post(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h!==last){last=h;parent.postMessage({type:${JSON.stringify(WIDGET_HEIGHT)},height:h},"*")}}
  if(window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.dataset.theme="dark";
  addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type===${JSON.stringify(WIDGET_THEME)}){document.documentElement.dataset.theme=e.data.theme;post()}});
  addEventListener("load",post);
  addEventListener("DOMContentLoaded",function(){new ResizeObserver(post).observe(document.body);post()});
})();
`;

/** The full page for a block's code: the AI writes the body (markup, <style>, <script>). */
export function widgetDocument(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style><script>${SCRIPT}</script></head><body>${code}</body></html>`;
}
