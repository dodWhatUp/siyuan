// ============================================================================
// Advanced Database (ADB) — schema FOUNDATION (no features yet).
// ----------------------------------------------------------------------------
// This module is the *base* that a future "advanced database" plugin activates.
// It defines a structured, self-describing BEHAVIOR LAYER that sits on top of a
// native SiYuan database (av), plus a documented accessor to read/write/validate
// it. It deliberately contains NO UI and NO property logic — only the contract,
// storage, and helpers, so any plugin (or an AI) can build on a stable shape.
//
// ── Why a separate layer? ───────────────────────────────────────────────────
// A native database already stores its columns ("keys") and per-row cell values.
// The ADB schema does NOT duplicate any of that. It only adds *behavior metadata*
// keyed by the native key id: advanced property types (e.g. date+reminder+repeat),
// grouping, conditional visibility, and references to reusable global types. The
// native data stays the single source of truth; the schema is small and only holds
// references, so the sole failure mode is a reference going stale (handled by
// resolve()). In stock SiYuan the schema is an inert custom attribute, so the
// database still renders normally — the behavior simply doesn't activate.
//
// ── Storage (hybrid + self-discovery) ───────────────────────────────────────
//   1. PER-DATABASE schema  → IAL attr `custom-adb` on the database block, a JSON
//      object (this file's `AdbSchema`). Lives in the `.sy` file (AI-readable from
//      disk), queryable via /api/attr/getBlockAttrs and the `attributes` SQL table,
//      synced with the workspace. Its presence also MARKS the block as advanced.
//   2. GLOBAL REGISTRY      → an ordinary SiYuan database whose block carries the
//      marker attr `custom-adb-registry`. Holds reusable TYPE definitions and (later)
//      global properties. Discoverable by the marker alone — no id needs to be known
//      in advance. A per-db schema may set `ref` to a registry id and reference its
//      types by id. Optional: a database with only local types needs no registry.
//
// An AI/plugin dropped anywhere can therefore: find the registry by its marker →
// from any block tell if it's advanced (and where its schema is) via `custom-adb`
// → learn the vocabulary from this file + notes/20 (pointed to by `$doc`).
//
// ── Sync / referential integrity ────────────────────────────────────────────
// Everything (native av data, the registry db, the `custom-adb`/marker attrs) lives
// under the workspace `data/` folder, so it all syncs together. Links use SiYuan
// KEY IDS, which are stable across renames — so renaming a column never breaks the
// schema. Deleting a column leaves an orphan reference; nothing is auto-cleaned, so
// resolve() cross-checks the schema against the live columns and reports orphans +
// unconfigured columns. Callers should treat resolve() output as the truth.
//
// Full specification + examples: notes/20-advanced-database-schema.md
// ============================================================================

import {fetchSyncPost} from "../../util/fetch";

// IAL attribute names. Both start with `custom-` so stock SiYuan persists + ignores
// them, and so they appear in the `.sy` file and the `attributes` table.
export const ADB_ATTR = "custom-adb";                 // per-database schema (JSON)
export const ADB_REGISTRY_ATTR = "custom-adb-registry"; // marks the global registry db
export const ADB_TYPES_ATTR = "custom-adb-types";     // reusable type defs (JSON) on the registry
export const ADB_VERSION = 1;
export const ADB_SCHEMA_ID = "siyuan-adb/v1";
export const ADB_DOC = "notes/20-advanced-database-schema.md";

// A condition for conditional / nested visibility: show this property only when
// another property's value matches. `op` defaults to "eq".
export interface AdbCondition {
    property: string;                                  // the controlling native key id
    op?: "eq" | "neq" | "in" | "empty" | "notEmpty";
    value?: unknown;                                   // compared value (array for "in")
}

// One advanced property = behavior layered onto a native column, keyed by key id.
export interface AdbProperty {
    type: string;                                      // "adb:date-reminder-repeat" | a global type id | a native type
    label?: string;                                    // optional display override (native name is the default)
    group?: string;                                    // id of an AdbGroup
    hidden?: boolean;                                  // hidden unless a feature reveals it
    showWhen?: AdbCondition;                            // conditional visibility
    config?: Record<string, unknown>;                  // type-specific config blob (reminder/repeat rules, etc.)
}

// A named, collapsible group of properties (presentation only).
export interface AdbGroup {
    id: string;
    label: string;
    collapsed?: boolean;
}

// The per-database schema stored in the `custom-adb` attribute.
export interface AdbSchema {
    $schema: string;                                   // ADB_SCHEMA_ID — identifies + versions the format
    $doc?: string;                                     // pointer to the human/AI spec
    version: number;                                   // ADB_VERSION
    ref?: string | null;                               // optional global registry block id
    properties: Record<string, AdbProperty>;           // keyed by native av key (column) id
    groups?: AdbGroup[];
}

// resolve() output: the schema cross-checked against the database's live columns.
export interface AdbResolved {
    schema: AdbSchema;
    columns: Array<{id: string; name: string; type: string}>; // live native columns
    orphans: string[];          // schema property ids with no matching live column
    unconfigured: string[];     // live column ids with no advanced config
    globalTypes: Record<string, unknown>; // type defs pulled from the registry (if any)
}

// A fresh, self-documenting empty schema.
export const emptySchema = (): AdbSchema => ({
    $schema: ADB_SCHEMA_ID,
    $doc: ADB_DOC,
    version: ADB_VERSION,
    ref: null,
    properties: {},
    groups: [],
});

const getAttrs = async (blockId: string): Promise<Record<string, string>> => {
    const r = await fetchSyncPost("/api/attr/getBlockAttrs", {id: blockId});
    return (r && r.data) || {};
};

// READ: the per-database schema, or null if the block isn't an advanced database.
export const read = async (blockId: string): Promise<AdbSchema | null> => {
    const attrs = await getAttrs(blockId);
    const raw = attrs[ADB_ATTR];
    if (!raw) {
        return null;
    }
    try {
        return {...emptySchema(), ...JSON.parse(raw)};
    } catch (e) {
        return emptySchema();
    }
};

// WRITE: persist the schema to `custom-adb`. Stamps the self-describing fields so
// the stored JSON is always identifiable on its own.
export const write = async (blockId: string, schema: AdbSchema): Promise<void> => {
    const out: AdbSchema = {...schema, $schema: ADB_SCHEMA_ID, $doc: ADB_DOC, version: ADB_VERSION};
    await fetchSyncPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {[ADB_ATTR]: JSON.stringify(out)}});
};

// Cheap check used by callers / discovery.
export const isAdvanced = async (blockId: string): Promise<boolean> => {
    const attrs = await getAttrs(blockId);
    return !!attrs[ADB_ATTR];
};

// VALIDATE: structural sanity (pure). Returns the list of problems; empty = ok.
export const validate = (schema: AdbSchema): {ok: boolean; errors: string[]} => {
    const errors: string[] = [];
    if (!schema || typeof schema !== "object") { return {ok: false, errors: ["schema is not an object"]}; }
    if (schema.$schema !== ADB_SCHEMA_ID) { errors.push(`unexpected $schema (want ${ADB_SCHEMA_ID})`); }
    if (typeof schema.version !== "number") { errors.push("version must be a number"); }
    if (!schema.properties || typeof schema.properties !== "object") { errors.push("properties must be an object"); }
    const groupIds = new Set((schema.groups || []).map((g) => g.id));
    Object.entries(schema.properties || {}).forEach(([keyId, p]) => {
        if (!p || typeof p.type !== "string" || !p.type) { errors.push(`property ${keyId}: missing type`); }
        if (p && p.group && !groupIds.has(p.group)) { errors.push(`property ${keyId}: group "${p.group}" not defined`); }
        if (p && p.showWhen && (!p.showWhen.property)) { errors.push(`property ${keyId}: showWhen needs a controlling property`); }
    });
    return {ok: errors.length === 0, errors};
};

// Fetch the live columns of a database (best-effort across renderAttributeView shapes).
const fetchColumns = async (blockId: string): Promise<Array<{id: string; name: string; type: string}>> => {
    try {
        const r = await fetchSyncPost("/api/av/renderAttributeView", {id: blockId});
        const d = (r && r.data) || {};
        const view = d.view || {};
        const cols = view.columns || d.keyValues || [];
        return cols.map((c: Record<string, unknown>) => ({
            id: String((c.id as string) || ((c.key as Record<string, unknown>) || {}).id || ""),
            name: String((c.name as string) || ((c.key as Record<string, unknown>) || {}).name || ""),
            type: String((c.type as string) || ((c.key as Record<string, unknown>) || {}).type || ""),
        })).filter((c: {id: string}) => c.id);
    } catch (e) {
        return [];
    }
};

// RESOLVE: the schema cross-checked against the live database + the global registry.
// This is the function features should call on load — it never throws on a deleted
// column; it reports orphans instead.
export const resolve = async (blockId: string): Promise<AdbResolved> => {
    const schema = (await read(blockId)) || emptySchema();
    const columns = await fetchColumns(blockId);
    const colIds = new Set(columns.map((c) => c.id));
    const orphans = Object.keys(schema.properties).filter((id) => !colIds.has(id));
    const unconfigured = columns.map((c) => c.id).filter((id) => !schema.properties[id]);
    let globalTypes: Record<string, unknown> = {};
    if (schema.ref) {
        globalTypes = await loadGlobalTypes(schema.ref);
    }
    return {schema, columns, orphans, unconfigured, globalTypes};
};

// FIND the global registry database by its marker — no id needs to be known up front.
export const findRegistry = async (): Promise<string | null> => {
    try {
        const r = await fetchSyncPost("/api/query/sql", {
            stmt: `SELECT block_id FROM attributes WHERE name='${ADB_REGISTRY_ATTR}' LIMIT 1`,
        });
        const rows = (r && r.data) || [];
        return rows.length ? String(rows[0].block_id) : null;
    } catch (e) {
        return null;
    }
};

// Load reusable type definitions stored on the registry database (as `custom-adb-types`).
export const loadGlobalTypes = async (registryId: string): Promise<Record<string, unknown>> => {
    try {
        const attrs = await getAttrs(registryId);
        const raw = attrs[ADB_TYPES_ATTR];
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
    }
};

// The accessor object exposed on the super-block SPI as `window.siyuan.superblock.adb`.
export const adb = {
    VERSION: ADB_VERSION,
    ATTR: ADB_ATTR,
    REGISTRY_ATTR: ADB_REGISTRY_ATTR,
    SCHEMA_ID: ADB_SCHEMA_ID,
    DOC: ADB_DOC,
    emptySchema,
    read,
    write,
    isAdvanced,
    validate,
    resolve,
    findRegistry,
    loadGlobalTypes,
};
