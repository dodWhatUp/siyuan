# Property-component schemas

Contracts for the **property components** (notes/16). A rich property is stored as **two native AV
columns** — no new kernel type:

1. **Canonical column** — a plain native column holding the queryable value (`date` for Rich-Date,
   `text` for Location). Fully usable in SiYuan's native table view and in SQL.
2. **Companion column** — a native `text` column whose content is a JSON object conforming to one of
   the schemas here. Each object is **self-describing**: it embeds

   - `"$schema"` — the schema `$id` (e.g. `siyuan-superblock/reminder@1`), so any reader (AI or tool)
     can locate this contract,
   - `"_type"` — a short discriminator (`reminder`, `location`).

This recovers the cohesion of a dedicated type while staying readable cold and round-tripping through
the stock API / SQL / other plugins.

## Which column is which?
Authoritative mapping comes from the component's **config** (the no-code form lets the user pick the
canonical column and the companion column). The `$schema`/`_type` discriminator inside the JSON is the
fallback when no config is present. **Naming convention** (a hint, not load-bearing): name the
companion `<Canonical> Meta` — e.g. canonical `Date` → companion `Date Meta`.

## Schemas
- `reminder.schema.json` — `$id: siyuan-superblock/reminder@1` — relative + absolute reminders + repeat.
- `location.schema.json` — `$id: siyuan-superblock/location@1` — name + WGS84 coordinates + address.

Versioned by `$id` suffix (`@1`, `@2`, …); never break a published version — add a new one.
