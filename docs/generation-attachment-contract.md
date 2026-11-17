# Generation application and bridge contract

PDF source metadata carries immutable attachment identity, original filename and selected one-based page numbers. Generation freezes those references per job before uploads begin; review restores them and acceptance copies them into the sections. Editing attachments later cannot relabel an existing bridge result.

Acceptance commits content, an event and a receipt in one IndexedDB transaction. The receipt identifies the complete reviewed result, independent of destination or selected subset. Imported sections carry that identity through sync, and deterministic imported section IDs prevent duplicate rows during concurrent offline acceptance. Repeated acceptance after sync returns the original destination. Conflicting offline destinations/selections follow the existing per-entity last-writer policy; this is not a distributed transaction.

Import jobs require Read and output-writing tools: Claude Write/Edit with cwd acceptEdits, Codex workspace-write. Claude shell execution and web access remain explicit options. Codex has shell capability within its configured sandbox. Ordinary tutoring responses never automatically apply notebook changes. Output-folder restrictions rely partly on prompt compliance within the writable job directory; the existing bridge review's ambient CLI limitations still apply.

Validation covers session/ownership boundaries, persistence and chunk retrieval, page provenance, failed upload cleanup, expiry, legacy/invalid payloads, preview cancellation, append, duplicate acceptance and bridge delivery/cleanup. Browser interactions, real multi-device sessions and paid AI execution were not exercised locally. Bridge process tests use fake agents and do not establish real CLI sandbox enforcement.
