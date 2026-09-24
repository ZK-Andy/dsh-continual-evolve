# Agent Note: Direct LLM session routing metadata

Status: implemented

## Problem

The v0.7.3 memory agent did run in the desktop profile, but opencode-go rejected its direct requests with `MissingSessionID`. The shared LLM boundary forwarded provider/model, messages, tools, reasoning effort, and cancellation, but omitted the host Agent session identity. The main agent loop stamps this identity itself; plugin-owned auxiliary calls must do the same.

## Decision

- Carry the host Agent id through the shared `streamText` / `streamModelTurn` boundary using the host `GenerateOptions.sessionId` type.
- Forward it on memory-agent requests and on review, planner, and wrap-up requests.
- Keep the identity optional at the generic helper boundary for tests and older hosts; when present it is passed unchanged to the adapter.
- Add a regression asserting the exact session id reaches `ctx.llm.stream`.

## Alternatives considered

- **Disable the desktop provider's session requirement**: rejected because the adapter's routing contract is external and this would hide the missing metadata.
- **Send a fabricated provider session header**: rejected because the plugin must use the host Agent identity and must not invent provider routing state.
- **Use the snapshot cursor as session id**: rejected because a cursor is a durable evidence boundary, not the host conversation identity.

## Consequences

Auxiliary review, memory extraction, planner, and wrap-up calls now use the same provider routing identity as the Agent loop. Providers that do not require the field remain compatible; tests and capability-less hosts may omit it. No new provider-specific header logic enters the plugin.
