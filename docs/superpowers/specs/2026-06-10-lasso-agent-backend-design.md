# Lasso AI builder → dashboard backend agent

**Date:** 2026-06-10
**Status:** Approved (Logan, 2026-06-10)
**Goal:** Lasso's plain-text AI flow becomes a second client of the dashboard
agent loop — functionally equivalent to the dashboard frontend — by hitting
`https://dashboard.mesa.cowboylabs.net/api/agent/chat` instead of streaming
directly from a vLLM runner.

## Context

Today lasso's AI actor builder (`src/app.tsx` `handlePromptSubmit`) streams raw
chat completions from a vLLM runner (`src/llm-client.ts`, OpenAI-compatible
`/v1/chat/completions`), extracts ```python actor blocks from the response text
(`src/actor-extractor.ts`), writes them to local files, and suggests
`/actor deploy`.

The dashboard frontend instead drives the backend **agent loop**
(`dashboard/backend/src/routes/agent.ts:1805`, `POST /api/agent/chat`): an SSE
stream of typed events with server-side tools (`write_actor` codegen,
`simulate_actor`, `cowboy_knowledge`, deploy/transfer signing tools) and
conversations persisted per wallet. The deployed Next.js app at
`https://dashboard.mesa.cowboylabs.net` proxies all `/api/*` to the backend
(`frontend/next.config.*` `rewrites()`), so the full API surface is reachable
at the public dashboard URL by any HTTP client. CORS only constrains browsers;
lasso is unaffected.

There is no literal "autocomplete" feature in the dashboard frontend; the agent
chat **is** the LLM feature lasso mirrors.

## Decisions (made with Logan)

1. **Scope:** reroute lasso's AI builder to `/api/agent/chat` (full agent loop),
   not a literal inline-autocomplete feature.
2. **Tool scope today:** chat + `write_actor` codegen + read-only tools.
   Signing tools (`tool_pending_signature`) are deferred: lasso shows a message
   directing the user to `/actor deploy` and aborts the stream.
3. **Default endpoint:** `https://dashboard.mesa.cowboylabs.net` becomes the
   default for the existing `dashboard_url` config field (today: null).
4. **Implementation approach:** port the protocol into lasso (new
   `src/agent-client.ts`); keep the direct-vLLM path as a legacy fallback. No
   shared cross-repo package today.

## Architecture & data flow

On plain-text prompt submit:

1. **Routing rule:**
   - `session.dashboardUrl` set → agent path (new, default).
   - else `session.runnerUrl` set → existing direct-vLLM path, unchanged.
   - else → setup error message.
   Removing `dashboard_url` from `.cowboy/config.json` opts back into direct
   mode.
2. **Conversation (lazy, session-scoped):** on first AI prompt of the session:
   `POST {dashboardUrl}/api/conversations` with
   `{"wallet": <session.walletAddress>, "kind": "builder", "firstMessage": <prompt>}`
   → store `conversation.id` in session state; reuse for subsequent prompts.
   New lasso session = new conversation (matches today's per-session
   `aiHistory`). Requires `session.walletAddress`; if missing, error directing
   the user to `/init`.
   Contract source: `dashboard/backend/src/routes/conversations.ts:80`.
3. **Chat:** `POST {dashboardUrl}/api/agent/chat` with
   `{"conversationId": <id>, "content": <prompt>}`. `model` and `planMode`
   omitted — the server resolves the model exactly as it does for the
   dashboard's default. The backend persists both turns server-side, so lasso
   does not send history; `aiHistory` remains only for the legacy path.
   Contract source: `dashboard/backend/src/routes/agent.ts:1805` and
   `dashboard/frontend/src/lib/agent/sse-client.ts`.
4. **Stream:** consume SSE frames (`data: <json>` separated by `\n\n`) until
   `done` or fatal `error`, mapping events to lasso messages per the table
   below.

## Components

| Unit | Change |
| --- | --- |
| `src/agent-client.ts` (new, ~200 lines) | `AgentEvent` types ported verbatim from `dashboard/frontend/src/lib/agent/events.ts`; SSE frame parser ported from `sse-client.ts` (handles frames split across chunks); `createConversation(dashboardUrl, wallet, firstMessage)`; `streamAgentChat(dashboardUrl, req, signal)` returning an async generator of events. One purpose: speak the protocol. |
| `src/app.tsx` | `handlePromptSubmit` branches: new `runAgentPrompt()` drives the event loop and message mapping. Legacy path untouched. |
| `src/config.ts` | `dashboard_url` defaults to `https://dashboard.mesa.cowboylabs.net` (normalized via `normalizeEndpointUrl`). |
| `src/actor-extractor.ts` | Factor the `@actor` class-name → `snake_case.py` path derivation out of `extractActors` into a reusable `deriveActorFile(code)`; fallback `actor.py`. Used to name files for `write_actor` output (which carries code but no path). |

## Event → UI mapping

Event shapes source: `dashboard/backend/src/agent/events.ts`.

| SSE event | Lasso behavior |
| --- | --- |
| `stream_start` | system message `AI builder (<model>)` — parity with today |
| `text_delta` | append to `streamingText` (existing live render) |
| `reasoning_delta` | ignored (spinner already conveys "thinking") |
| `tool_use_start` | system message `⚙ <displayName ?? toolName>…` |
| `tool_output_delta` (channel `draft`) | append to `streamingText` so codegen streams visibly, like the dashboard |
| `tool_output_delta` (channels `repair`, `log`) | ignored — the file is written from `tool_result.output.code`, which is already post-repair, so streaming the repair pass would just show two code versions |
| `tool_result` (`write_actor`, status ok) | write `output.code` to derived local path; system messages `Wrote <name> to <path>` and `Deploy with: /actor deploy <path>` — today's exact UX |
| `tool_result` (other tools) | system message with `summary`/status |
| `tool_pending_signature` | system message: needs a wallet signature, run `/actor deploy <file>` instead; then abort the stream (lasso cannot resolve a signature; hanging is worse) |
| `error` | error message; abort when `recoverable: false` |
| `done` | replace streamed text with `finalAssistantContent` as the final output message (server-sanitized; same swap the dashboard does at `ChatView.tsx:482`) |

`write_actor` output shape (source `dashboard/backend/src/agent/tools/write-actor.ts`):
`{status: "ok"|"error", language: "python", code: string, warnings: string[], notes: string}`.

## Error handling

- Conversation-create failure or chat non-200: one-line error naming the URL,
  suggesting a `dashboard_url` config check.
- Mid-stream disconnect: keep partial streamed text, show an error message.
- Escape / Ctrl+C: abort via `AbortController`, matching existing interrupt
  handling.
- No wallet address: error directing to `/init`.

## Testing

- Unit tests (existing `node --test` suite, `make check`):
  - SSE parser against fixture frames, including frames split across chunks and
    every event type.
  - `write_actor` `tool_result` → file write mapping (derived path, fallback).
  - Routing rule: dashboard set / runner only / neither.
- Manual smoke against live mesa before shipping.
- TDD during implementation.

## Out of scope today (fast-follows)

- Signing round-trip: `tool_pending_signature` → sign with local `.cowboy` key
  → `POST /api/actors/deploy/submit`.
- Model picker backed by `/api/models/available`.
- Conversation resume across lasso sessions.
- Shared protocol package consumed by both dashboard frontend and lasso.
