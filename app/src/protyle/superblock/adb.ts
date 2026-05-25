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

// ── Type registry (in-memory vocabulary) ────────────────────────────────────
// A property's `type` is a string id. The registry lets plugins DECLARE the types
// they understand (id + an optional config validator + metadata), so multiple
// plugins agree on ids and `validate()` can check a property's `config` against its
// type. This is runtime/in-memory (re-declared each session, like the feature/preset
// registries) — it is NOT the persisted global-types store (see loadGlobalTypes).
export interface AdbTypeDef {
    id: string;                                        // e.g. "adb:date-reminder-repeat"
    label?: string;
    base?: string;                                     // native av type it extends (e.g. "date")
    description?: string;
    // Return a list of problems with the given config; empty array = valid.
    validateConfig?: (config: Record<string, unknown> | undefined) => string[];
}

const typeRegistry = new Map<string, AdbTypeDef>();

export const registerType = (def: AdbTypeDef): void => {
    if (def && def.id) { typeRegistry.set(def.id, def); }
};
export const getType = (id: string): AdbTypeDef | undefined => typeRegistry.get(id);
export const listTypes = (): AdbTypeDef[] => Array.from(typeRegistry.values());

// Validate a config blob against a registered type. Unknown types pass (a plugin may
// own them); registered types defer to their own validateConfig.
export const validateConfig = (typeId: string, config: Record<string, unknown> | undefined): string[] => {
    const def = typeRegistry.get(typeId);
    if (!def || !def.validateConfig) { return []; }
    try { return def.validateConfig(config) || []; } catch (e) { return [`config validator threw: ${(e as Error).message}`]; }
};

// Reserved CORE type ids — declared here so the vocabulary is stable across plugins.
// These are DEFINITIONS / shape contracts only; the actual behavior + UI live in the
// feature plugin, which may re-register the same id to attach its runtime.
registerType({
    id: "adb:date-reminder-repeat",
    label: "Date + reminder + repeat",
    base: "date",
    description: "A date column with an optional relative reminder and a recurrence rule. " +
        "config: { reminder?: {mode:'relative'|'absolute', offsetMinutes?:number, at?:string}, " +
        "repeat?: {freq:'daily'|'weekly'|'monthly'|'yearly', interval?:number, byDay?:string[], until?:string|null} }",
    validateConfig: (c) => {
        const errs: string[] = [];
        if (!c) { return errs; }
        const r = c.reminder as Record<string, unknown> | undefined;
        if (r && r.mode && !["relative", "absolute"].includes(String(r.mode))) { errs.push("reminder.mode must be 'relative' or 'absolute'"); }
        const rep = c.repeat as Record<string, unknown> | undefined;
        if (rep && rep.freq && !["daily", "weekly", "monthly", "yearly"].includes(String(rep.freq))) { errs.push("repeat.freq invalid"); }
        return errs;
    },
});

// A fresh, self-documenting empty schema.
export const emptySchema = (): AdbSchema => ({
    $schema: ADB_SCHEMA_ID,
    $doc: ADB_DOC,
    version: ADB_VERSION,
    ref: null,
    properties: {},
    groups: [],
});

// ── Migration ────────────────────────────────────────────────────────────────
// Upgrade an older schema to the current version. v1 is the first version, so this
// is currently a stamp/normalize; future versions add steps here. read() runs it so
// callers always get a current-shaped schema.
export const migrate = (schema: AdbSchema): AdbSchema => {
    const s: AdbSchema = {...emptySchema(), ...schema};
    // (future: if (s.version < 2) { …transform…; s.version = 2; })
    s.version = ADB_VERSION;
    s.$schema = ADB_SCHEMA_ID;
    return s;
};

// ── Change notification ──────────────────────────────────────────────────────
// write() notifies subscribers so live views can refresh. Self-contained (not wired
// to the global SPI emitter) to keep the base decoupled.
type AdbChangeListener = (blockId: string, schema: AdbSchema) => void;
const changeListeners = new Set<AdbChangeListener>();
export const onChange = (cb: AdbChangeListener): (() => void) => {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
};
const emitChange = (blockId: string, schema: AdbSchema): void => {
    changeListeners.forEach((cb) => { try { cb(blockId, schema); } catch (e) { /* ignore */ } });
};

// ── Conditional visibility (pure) ────────────────────────────────────────────
// Shared semantics so every plugin decides "show this property?" identically.
// rowValues maps a native key id → that cell's value (see readRow).
export const evaluateCondition = (cond: AdbCondition, rowValues: Record<string, unknown>): boolean => {
    if (!cond || !cond.property) { return true; }
    const v = rowValues ? rowValues[cond.property] : undefined;
    const op = cond.op || "eq";
    switch (op) {
        case "empty": return v === undefined || v === null || v === "";
        case "notEmpty": return !(v === undefined || v === null || v === "");
        case "neq": return v !== cond.value;
        case "in": return Array.isArray(cond.value) && (cond.value as unknown[]).includes(v);
        case "eq":
        default: return v === cond.value;
    }
};

// Is a property visible for a given row? Hidden wins; otherwise honour showWhen.
export const isVisible = (prop: AdbProperty, rowValues: Record<string, unknown>): boolean => {
    if (!prop) { return false; }
    if (prop.hidden) { return false; }
    if (prop.showWhen) { return evaluateCondition(prop.showWhen, rowValues || {}); }
    return true;
};

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
        return migrate(JSON.parse(raw));
    } catch (e) {
        return emptySchema();
    }
};

// WRITE: persist the schema to `custom-adb`. Stamps the self-describing fields so
// the stored JSON is always identifiable on its own.
export const write = async (blockId: string, schema: AdbSchema): Promise<void> => {
    const out: AdbSchema = {...schema, $schema: ADB_SCHEMA_ID, $doc: ADB_DOC, version: ADB_VERSION};
    await fetchSyncPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {[ADB_ATTR]: JSON.stringify(out)}});
    emitChange(blockId, out);
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
        // Type-specific config check, when the type is registered.
        if (p && p.type) {
            validateConfig(p.type, p.config).forEach((e) => errors.push(`property ${keyId} (${p.type}): ${e}`));
        }
    });
    return {ok: errors.length === 0, errors};
};

// Resolve a database BLOCK id → its AV id. renderAttributeView wants the av id; the
// block stores it as `data-av-id` in its markdown. Falls back to the block id.
const avIdOf = async (blockId: string): Promise<string> => {
    try {
        const q = await fetchSyncPost("/api/query/sql", {stmt: `SELECT markdown FROM blocks WHERE id='${blockId}' LIMIT 1`});
        const md = (((q && q.data) || [])[0] || {}).markdown || "";
        const m = md.match(/data-av-id="([^"]+)"/);
        return m ? m[1] : blockId;
    } catch (e) { return blockId; }
};

// Fetch the live columns of a database (best-effort across renderAttributeView shapes).
const fetchColumns = async (blockId: string): Promise<Array<{id: string; name: string; type: string}>> => {
    try {
        const r = await fetchSyncPost("/api/av/renderAttributeView", {id: await avIdOf(blockId), blockID: blockId, pageSize: 1, viewID: "", query: ""});
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

// READ a single database row's cell values, keyed by native key id. Standardizes the
// (fiddly) av read so conditions/reminders/features all read values the same way.
// Returns {} if the row isn't found. Best-effort across renderAttributeView shapes.
export const readRow = async (blockId: string, rowId: string): Promise<Record<string, unknown>> => {
    try {
        const r = await fetchSyncPost("/api/av/renderAttributeView", {id: await avIdOf(blockId), blockID: blockId, pageSize: 500, viewID: "", query: ""});
        const view = ((r && r.data) || {}).view || {};
        const rows = (view.rows || []).concat(...((view.groups || []).map((g: Record<string, unknown>) => (g.rows as unknown[]) || [])));
        const row = rows.find((rw: Record<string, unknown>) => String(rw.id) === String(rowId));
        if (!row) { return {}; }
        const out: Record<string, unknown> = {};
        ((row.cells as Array<Record<string, unknown>>) || []).forEach((cell) => {
            const val = (cell.value as Record<string, unknown>) || {};
            const keyId = String(val.keyID || cell.keyID || "");
            if (keyId) { out[keyId] = val; }
        });
        return out;
    } catch (e) {
        return {};
    }
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

// ENSURE the global registry exists, returning its block id. If none is found by the
// marker, create a plain DOCUMENT carrying the marker — a doc (not a database) is
// enough for the base, since the registry only needs to hold reusable type defs (in
// `custom-adb-types`) and be discoverable. A future "global database" feature can add
// a real av INSIDE this doc. Creating a doc is reliable; creating an av is not.
export const ensureRegistry = async (): Promise<string | null> => {
    const existing = await findRegistry();
    if (existing) { return existing; }
    try {
        const nb = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebooks = ((nb && nb.data) || {}).notebooks || [];
        const open = notebooks.find((n: Record<string, unknown>) => !n.closed) || notebooks[0];
        if (!open) { return null; }
        const created = await fetchSyncPost("/api/filetree/createDocWithMd", {
            notebook: open.id, path: "/ADB Schema Registry",
            markdown: "# ADB Schema Registry\n\nReusable advanced-database type definitions are stored in this document's attributes (`custom-adb-types`). Managed by the advanced-database system — see notes/20.",
        });
        const docId = created && created.data;
        if (!docId) { return null; }
        await fetchSyncPost("/api/attr/setBlockAttrs", {id: docId, attrs: {[ADB_REGISTRY_ATTR]: "v1"}});
        return docId;
    } catch (e) {
        return null;
    }
};

// Persist the reusable type-definition map onto the registry doc (`custom-adb-types`).
export const saveGlobalTypes = async (registryId: string, types: Record<string, unknown>): Promise<void> => {
    await fetchSyncPost("/api/attr/setBlockAttrs", {id: registryId, attrs: {[ADB_TYPES_ATTR]: JSON.stringify(types)}});
};

// Convenience: add/update one reusable type in the registry (creating it if needed).
export const registerGlobalType = async (id: string, def: Record<string, unknown>): Promise<string | null> => {
    const registryId = await ensureRegistry();
    if (!registryId) { return null; }
    const types = await loadGlobalTypes(registryId);
    types[id] = def;
    await saveGlobalTypes(registryId, types);
    return registryId;
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
    migrate,
    // type vocabulary
    registerType,
    getType,
    listTypes,
    validateConfig,
    // conditional visibility (pure)
    evaluateCondition,
    isVisible,
    // row value access
    readRow,
    // global registry
    findRegistry,
    ensureRegistry,
    loadGlobalTypes,
    saveGlobalTypes,
    registerGlobalType,
    // change notification
    onChange,
};
