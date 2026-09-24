# Alert format reference

Deep payload reference for `Travian Attack Alert` `1.0.1` (`taa-1.0.1`). The short contract, the generated examples, and the install path live in the main [`README.md`](../README.md); this page explains the request anatomy, mention policy, per-request limits, multi-part splitting, and delivery outcomes. Daily operation and recovery steps are in [`OPERATIONS.md`](OPERATIONS.md).

Every value on this page is synthetic (`world.example.invalid`, fixture player IDs `900001`+). No real alliance, player, host, or webhook appears here.

## Request envelope

One logical dispatch is one or more Discord requests. Each request is a JSON object:

| field | contents |
| --- | --- |
| `content` | top-level mention tokens for the first request of a batch, bounded and deduplicated to fit the 2000-character content limit; empty on continuations |
| `allowed_mentions` | an explicit allowlist (`{ users: [...], roles: [...] }`); there is no `parse` key |
| `embeds` | between 1 and 10 embeds; the title, URL, and three summary fields appear only on the first embed of a request, and the footer and timestamp only on that request's final embed |

Embed titles, descriptions, field values, and footers never contain mention tokens. Mentions live only in the top-level `content` field, so a mention cannot leak into a link title or a field body. Payloads use safe links in DOM order and the mention policy is explicit.

## First embed fields

The first embed has exactly `New`, `Active now`, and `Priority` — the three summary fields of every request's first embed, in this order:

1. `New` — the positive net delta since the previous accepted scan (for example `New: **+2 raids**`).
2. `Active now` — the observed totals at scan time (for example `Active now: 0 attacks / 2 raids`).
3. `Priority` — the configured priority band for the batch (for example `Priority: Normal`).

Continuation embeds in the same request carry only the player-description body. The batch title, alliance URL, and the three summary fields above appear only on the first embed of each request; the footer and timestamp appear only on that request's final embed. When a request has a single embed, that embed carries the first-embed fields, the footer, and the timestamp together.

## Titles, footer, and timestamp

- The title is `🚨 Alliance attack`, `🛡️ Alliance raid`, or `🔄 Alliance changes`, followed by a linked alliance/member title and a singular/plural player count.
- The footer is `<hostname> · <observation-text>`.
- The footer and the one logical dispatch timestamp are placed on the last embed of every request, so each request carries that request's footer and timestamp once. `Timestamp:` lines in the README examples come from the live canonical builder.

## Mention policy

- Mentions occur once per batch; continuations use empty mention allowlists.
- Attack role (`roleId`) pings on attack and mixed batches. Leave-moderator role (`leaveRoleId`) is a separate global role pinged when a batch contains a departure.
- A role pings only when the corresponding Discord role is Mentionable.
- A departing player is personally mentioned only when a pre-existing `mappings[hostname][playerId]` mapping already exists. The first request may therefore carry `content` such as `<@&leaveRoleId> <@userId>` exactly as the live builder emits it.
- Both role IDs live in `travianAllianceDiscordConfig_v1` and are validated by `validateDiscordRoleId`.
- Example first-request allowlist: `allowed_mentions: { users: ["<discord-user-id>"], roles: ["<discord-role-id>"] }`. When nobody is mentioned it is `{ users: [] }`. Continuations use empty `content` with `{ users: [] }` and no `roles` key.

## Per-request limits

Discord limits are measured with JavaScript UTF-16 `.length`:

| element | limit |
| --- | --- |
| content | 2000 |
| embed title | 256 |
| embed description | 4096 |
| field name | 256 |
| field value | 1024 |
| total embed text | 6000 |
| embeds per request | 10 |

## Multi-part splitting

A batch that exceeds the per-request budget is split into multiple requests. Every request repeats global context, adds `part X/Y`, and keeps its own embeds within the limits above. The split is deterministic: payloads are built once and the resume path reuses the same in-memory payload array, so a retry after a lost acknowledgement does not rebuild changed bytes from settings or cache.

`wait=true` exists only in the in-memory send URL; it is not persisted in storage or printed in diagnostics.

## Delivery outcomes

Delivery is at-least-once, so a lost acknowledgement can deliver the same batch twice:

- HTTP 200 with a message ID acknowledges the payload.
- Network errors, timeouts, aborts, 408, 429, and 5xx responses are retried with bounded backoff.
- Any other, non-retryable 4xx response stays `failed` and waits for manual recovery.
- A malformed or ID-less 200 is `uncertain` and is not retried automatically.

Failed and uncertain batches are never dropped silently. Recovery actions (`Retry failed Discord batches`, `Retry uncertain Discord batches`, `Mark uncertain Discord batches delivered`, `Flush pending Discord batches`) live in the Tampermonkey menu, never in the panel. See [`OPERATIONS.md`](OPERATIONS.md#queue-check).

## Observation time

No historical or guessed time is invented. When the observation time is missing, the text remains `Observation time unavailable`; inherited timestamps remain marked as approximate observation. Events that appear and disappear between two accepted scans cannot be inferred — that limitation is by design.

The superseded 5.2.6-era contract is historical; the 1.0.1 contract documented here is the one this candidate implements.

## Related

- [`README.md`](../README.md) — overview, install, quick start, and generated examples.
- [`OPERATIONS.md`](OPERATIONS.md) — daily routine, queue recovery, handover, and diagnostics.
- [`architecture.md`](architecture.md) — module graph, design tokens, and panel-versus-menu boundary.
