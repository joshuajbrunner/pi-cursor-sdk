# Cursor SDK event-debug artifacts

When `PI_CURSOR_SDK_EVENT_DEBUG` is enabled, pi-cursor-sdk writes one artifact directory per provider turn under `.debug/cursor-sdk-events/` (or the configured debug directory). Captures contain full prompt text and may contain sensitive user/project data: do not commit or share them without reviewing and redacting them. A session directory also contains `session.json`, which identifies its turn directories.

## Files

Each turn may contain:

- `metadata.json`: capture metadata, including `providerMeta` when available. The provider metadata may contain `rawSystemHash`, `sanitizedSystemHash`, `wouldBootstrapOnRaw`, and `wouldBootstrapOnSanitized`.
- `send-payload.json`: the prompt payload sent to Cursor (`text` and optional `images`). Send mode is recorded in `providerMeta.sendPlan` in `metadata.json`.
- `context-snapshot.json`: the pi context used for the turn.
- `lifecycle.jsonl`: lifecycle hook events. Each record has `hook`, `phase` (`enter` or `exit`), `depth`, and shared timing fields (`seq`, `t`, `ts`); model, runtime, duration, and error fields may also be present.
- `prompt-mutations.jsonl`: prompt rewrite metadata. Records identify a `label`, `changed`, lengths, SHA-1 values, sequence, and `beforeBody`/`afterBody` path references.
- `prompt-mutations.diff`: an accumulated human-readable prompt diff containing the full text changes. The referenced full texts are also stored under `prompt-bodies/` when body persistence is active; body files are conditional on debug sink creation.
- `tool-activation.jsonl`: active-tool read/modify/write observations. Records have `source`, optional `reason`, full `before` and `after` tool-name arrays, and computed `added` and `removed` arrays.
- `skill-state.jsonl`: skill-map observations with `site`, `operation`, `beforeKeys`, and `afterKeys`, plus counts.
- `provider-events.jsonl`, `stream-events.jsonl`, `on-step.jsonl`, `on-delta.jsonl`, `bridge-events.jsonl`, and related JSONL files: provider, stream, bridge, and display diagnostics. Their records are self-describing and use the same capture convention where applicable.
- `summary.json`, `conversation.json`, `errors.jsonl`, and `final-partial.json`: end-of-turn result, conversation, error, and partial-output data when produced.

Prompt bodies are retained in the `prompt-bodies/` directory when body persistence is enabled. Prompt mutation records and `prompt-mutations.diff` retain full text rather than only hashes, so removed tool catalogs and context sections can be inspected directly.

## Correlation

`seq` is a process-local monotonic sequence shared by lifecycle, prompt-mutation, tool-activation, and skill-state records. It permits ordering observations across otherwise separate files. A tool activation at one sequence number followed by its first appearance in a later prompt mutation indicates registration lag; compare turn directories to distinguish same-turn ordering from a later-turn appearance.

## Diagnosing behavior

- **Wasted bootstrap:** in `providerMeta`, find a turn where `wouldBootstrapOnRaw` is `true` and `wouldBootstrapOnSanitized` is `false`. The raw prompt changed enough to request a new agent even though the sanitized prompt sent to Cursor did not.
- **Concurrent hooks:** inspect `lifecycle.jsonl` for `depth > 1`, or an `enter`/`exit` interval containing another hook's `enter`. This proves asynchronous lifecycle work overlapped.
- **Lost active-tool updates:** order `tool-activation.jsonl` by `seq` and check sequential consistency: each record's `before` should equal the preceding record's `after`. A discontinuity means a stale read, or an unobserved writer between the cited records; it is a triage signal, not proof. Apply the same check across adjacent turns only when explicit same-process identity (`processId` or `pid`), zero `droppedCount`, and ordered sequence are established; otherwise report the boundary as unchecked. An absent activation file breaks the chain; an empty present file preserves an observed state.
- **One-turn-late activation:** order tool-activation and prompt-mutation records by `seq`, then find an activated tool whose name first occurs in a later prompt body. This demonstrates that the current prompt was built before the activation was visible.
- **Prompt churn:** list mutation labels whose `changed` flag is true. The usual labels are `sanitize`, `skill-rewrite`, and `agents-context-dedup`.

The repository includes `scripts/triage-cursor-sdk-events.mjs` for a compact triage report. Pass either a turn directory or a session directory. Every reported finding cites the raw artifact path, JSONL line, sequence, and (where useful) the record or prompt-body path so it can be checked quickly with the original files. This script is a triage aid, not proof: exit codes mean that something may be worth a human's time, not that a defect is established. Draw conclusions from the cited raw records and prompt bodies. Exit 0 means no finding was produced with complete coverage, exit 1 means findings were produced, and exit 2 means required data was missing or malformed.
