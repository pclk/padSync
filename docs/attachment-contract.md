# Persistent lecture PDFs

On AI import, upload PDFs to the lecture library or an existing notebook. The picker and drop area use chunked uploads; progress, offline, failed and unavailable states appear beside the files. View opens the browser PDF viewer. Enter one-based pages or ranges (for example `2, 4-5`), then select the PDF for generation. Page edits deselect the file until selected again. Ranges are manual and are not checked against the document's page count.

Saved originals live in owner-scoped Postgres rows, separate from local drafts and temporary AI jobs. Reopening the notebook's AI & PDFs page on another signed-in device retrieves the originals. Successful acceptance adds a notebook association without removing previous associations. Deleting a saved PDF removes its stored bytes; section filename/page references remain. Failed uploads attempt cleanup, and listing removes incomplete uploads older than 24 hours.

Generation uses the existing `import` job and chunked input API. Files are staged under safe `lectures/` paths in the bridge job directory. `request.md` records original names and selected pages; prompts contain file paths, never whole document contents. The original PDF is delivered intact; page restrictions are instructions to the AI, not extracted subsets. Temporary job files are removed on success, failure or cancellation.

Review supports mixed blocks and legacy JSON. Select valid sections, choose a new or existing notebook, and explicitly apply. Previewing, clearing or leaving the preview writes no notebook content. To retain structured source references with manually pasted JSON, use the preview's selected PDF references button after pasting. Bridge results restore their frozen generation references automatically.

Attachment APIs require browser sessions. Device tokens, foreign owners and cross-origin mutations are rejected. Item routes check ownership before listing or changing bytes. PDF size and chunk lengths are bounded, the signature is checked, and finalized bytes cannot be changed. Native viewing and AI tools interpret the PDF contents; this feature does not add OCR or Canvas ingestion.
