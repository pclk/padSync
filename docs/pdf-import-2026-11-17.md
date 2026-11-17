# Direct PDF notebooks (2026-11-17)

Library and AI import both offer **Import PDF**, with a picker, drop area, progress,
cancel and status messages. The filename becomes the notebook title. Each PDF page
becomes one plain section, with its rotated viewport aspect ratio scaled to 1376 px.
The limit is 100 MiB and 2000 pages. A4 portrait sections are about 1948 px tall.
Invalid/encrypted PDFs surface pdf.js errors. No OCR is added; screenshots and handwriting
remain in the page raster, while existing PDF text is extracted with getTextContent.

## Storage and upload

Pinned dependencies: pdfjs-dist 6.5.438; AWS S3 client and presigner 3.1170.0.
`/api/pdfs` uses the same browser-session guard as attachments. Device bearer tokens,
foreign owners and cross-origin writes are refused. Keys contain a SHA-256 of the
normalized login and a server-generated UUID; original filenames never become keys.
Owner and canonical key are checked before every download, completion or abort.

The browser parses pages and calculates SHA-256, then requests multipart PUT URLs.
Every upload uses 8 MiB parts (including small PDFs as a single multipart part), with
one part in flight at a time. URLs expire after one hour. The browser sends bytes
directly to the private Neon bucket, bypassing the Vercel request-body limit.
Completion lists and checks every part's number/length, completes S3 multipart,
checks HEAD size and reads only the five-byte PDF signature. Postgres stores metadata
in `notebook_pdfs`: owner, notebook id, object key, original name, size, page count,
client-computed SHA-256, ready, upload id and creation time. No PDF bytes enter SQL.
SHA-256 and page count are supplied by the browser; the server checks signature and
size, not full content parsing or hashing. Downloads verify size, signature and
SHA-256 before caching. Completed multipart URLs cannot overwrite the object.
GET URLs expire after five minutes and API responses are no-store.

Cancellation/failure attempts multipart abort and object deletion before removing
pending metadata. Tab crashes, network loss during cleanup, or failures after remote
completion can leave pending/orphaned objects. Operators can inspect `notebook_pdfs`
where ready=false and use AbortMultipartUpload/DeleteObject for stale keys, then
remove their rows. Neon does not currently enforce stored lifecycle policies.
There is no automatic resumable upload or garbage collection in this version.

The notebook and all sections save together through createNotebook, retaining the
existing HLC, offline writes and ink sync. PDF bytes cache in IndexedDB's metadata
store on import and first open on another device. Browser quota/eviction still applies.
**Local only** deliberately stores the original on this device without upload; its
synced section references cannot retrieve the original on another device. Missing
storage configuration gives an explicit message and offers the local option.

Existing `lecture_pdfs` / `lecture_pdf_parts` remain unchanged: AI generation sends
those originals through the established bridge chunk contract. Migrating them would
require coordinated read/upload/cleanup changes and a verified data migration.

## Rendering, export and Ask AI

pdf.js loads dynamically in the browser. The worker uses new URL relative to
import.meta.url, so Next 16 emits a hashed worker under /_next/static/media; the
existing service worker caches it. Worker rendering is disabled to use the browser
canvas path. IntersectionObserver mounts rasters only within 800 px of the viewport;
leaving releases the image URL. Rendering is serialized with at most six compressed
page rasters cached and two document workers retained. Canvases are cleared after
rasterization and pdf.js page resources cleaned. Ink tiles and gesture handling
are unchanged. PDF JavaScript/actions are never executed by the application.

Copy, export and Ask renders explicitly rasterize the PDF under typed text and ink,
even when that page is offscreen. The PDF occupies section coordinates starting at
(0,0). Ask notebook.md includes original filename, one-based page number and extracted
text for exactly the selected sections. Lasso crops use the same composite exporter.
The existing 3.2 MB/64-file bundle limits and skipped-render preview still apply;
asking about all 149 pages may omit later rasters, so select relevant pages for detail.

## Setup and verification

See README's setup table and Neon storage instructions for credentials and CORS.
No live bucket was provisioned in this implementation session. Vitest exercises the
routes with real PGlite metadata and mocked S3, including ownership, metadata limits,
part lengths, signature, readiness, presigned requests and bundle selection. A production
Next build verifies worker bundling. Actual iPad memory/scrolling, live Neon credentials,
CORS and the motivating 149-page file require device/environment acceptance testing.
