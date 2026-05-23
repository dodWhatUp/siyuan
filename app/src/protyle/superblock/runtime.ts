// Super-block runtime — compiles and runs a block's user code with a
// capability-gated context (see notes/06-superblock-implementation-plan.md).
//
// Capabilities: compute + ui + persist + api + network + embed. Gating by
// omission — only the capabilities a preset enables are attached to `ctx`, so a
// smaller profile is strictly cheaper and exposes less surface. `api`/`network`
// are off by default: each is granted only after a first-use confirm, then
// remembered per device (policy.ts). Not yet built: libs (`ctx.require`) and
// auto-cleaned timers — both will add to `ctx` WITHOUT changing this contract.

import {fetchPost, fetchSyncPost} from "../../util/fetch";
import {confirmDialog} from "../../dialog/confirmDialog";
import {effectiveCaps, isKilled, hasGrant, addGrant, policySignature} from "./policy";
import {getAllEditor} from "../../layout/getAll";
import {openFileById} from "../../editor/util";
import {openNewWindowById} from "../../window/openNewWindow";
import {Constants} from "../../constants";
import {addScript} from "../util/addScript";
import {superblockRender, SB_MARKER, SB_CODE} from "../render/superblockRender";
import {genIconHTML} from "../render/util";

export type Capability = "compute" | "ui" | "persist" | "api" | "network" | "embed" | "libs" | "timers" | "watch" | "write" | "self" | "bind" | "channel" | "av";

export interface SuperBlockCtx {
    blockId: string;
    el?: HTMLElement; // present only when the "ui" capability is enabled
    // present only when the "persist" capability is enabled. Reads/writes a JSON
    // blob stored in the block's `custom-sb-state` IAL attribute (travels with
    // sync/export). set() is fire-and-forget — DOM is updated synchronously so a
    // re-render sees the new value, the kernel write happens in the background.
    state?: {
        get: <T = unknown>(key: string) => T | undefined;
        set: (key: string, value: unknown) => void;
    };
    // the SiYuan kernel namespace. `post` (read-only allowlist) is present with the
    // "api" capability; `write` (mutating allowlist, no deletes) with the "write"
    // capability. Both prompt a per-block confirm on first use; writes are logged.
    api?: {
        post?: (path: string, body?: object) => Promise<IWebSocketData>;
        write?: (path: string, body?: object) => Promise<IWebSocketData>;
    };
    // present only when the "network" capability is enabled. Pass-through to the
    // browser fetch after a first-use confirm; grants are per-domain (policy.ts),
    // which doubles as the network allowlist.
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    // present only when the "embed" capability is enabled. Mounts a REAL nested
    // Protyle editor for the target block into ctx.el — fully editable, unlike a
    // stock read-only embed. The nested editor is destroyed on re-render.
    embed?: (targetBlockId: string, container?: HTMLElement) => void;
    // present with the "embed" capability. Embeds the target block in an ISOLATED
    // iframe (its own browsing context) — structurally immune to the host's input
    // pipeline (no dual-id / double-Enter / refresh loop). Fully editable.
    embedFrame?: (targetBlockId: string, container?: HTMLElement) => void;
    // present with the "ui" capability. Opens a block in the current tab (focused)
    // or a new window — used by search results to make rows openable/editable.
    open?: (id: string, newWindow?: boolean) => void;
    // present only when the "libs" capability is enabled. Lazy-loads an
    // allowlisted library from CDN (cached per session) and resolves to its
    // global, e.g. `const Chart = await ctx.require("chartjs")`.
    require?: (name: string) => Promise<unknown>;
    // present only when the "timers" capability is enabled. Like the globals, but
    // tracked and auto-cleared on unmount/re-render (no leaked intervals).
    setInterval?: (handler: () => void, ms: number) => number;
    setTimeout?: (handler: () => void, ms: number) => number;
    onUnmount?: (cb: () => void) => void;
    // present only when the "watch" capability is enabled. Calls `cb` (debounced)
    // whenever the vault changes (any kernel WS message), so a query-view block
    // can refresh itself live. Auto-unsubscribed on unmount.
    watch?: (cb: () => void) => void;
    // present only when the "self" capability is enabled. The block's own identity
    // and IAL attributes — read/write its own `custom-*` attributes without the
    // api/write gates (it's only touching itself). Foundation for ctx.bind.
    self?: {
        id: string;
        docId: string;
        getAttr: (key: string) => string | null;
        setAttr: (key: string, value: string) => void;
    };
    // present only when the "bind" capability is enabled. Two-way binds a form
    // control to one of the block's own attributes: the control shows the stored
    // value, edits write back (debounced), and external changes update the control.
    bind?: (attrKey: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => void;
    // present only when the "channel" capability is enabled. In-doc pub/sub: one
    // block emits on a named channel, others react — lets a filter block drive
    // several view blocks. Subscriptions auto-removed on unmount.
    channel?: (name: string) => {
        emit: (data: unknown) => void;
        on: (cb: (data: unknown) => void) => void;
    };
    // present only when the "av" capability is enabled. Reads a SiYuan database
    // (Attribute View) — its columns + rows — so a block can render views the
    // native database lacks (calendar, timeline, …). Read-only here; first use
    // prompts a confirm. (Cell writes come via a later step on top of "write".)
    av?: {
        read: (avId: string) => Promise<{columns: unknown[]; rows: unknown[]; viewType: string}>;
        // Write one cell (e.g. a date) back to the database. `data` is the typed
        // cell-value object for that column type. Gated by the write confirm.
        setCell: (op: {avID: string; rowID: string; keyID: string; cellID: string; data: unknown}) => Promise<IWebSocketData>;
    };
    // present in FEATURE mode: the block's parsed, validated config (from
    // custom-sb-config merged over the feature's defaultConfig). Lets a feature's
    // run(ctx, config) be config-driven instead of hard-coded (notes/14, L2/L3).
    config?: Record<string, unknown>;
}

// A preset is a named capability profile — the user-facing "block type".
export interface SuperBlockPreset {
    caps: Capability[];
}

export const PRESETS: Record<string, SuperBlockPreset> = {
    calc: {caps: ["compute", "ui"]},
    hello: {caps: ["compute", "ui"]},
    data: {caps: ["compute", "ui", "persist", "self", "bind"]},
    embed: {caps: ["compute", "ui", "embed"]},
    viz: {caps: ["compute", "ui", "libs"]},
    live: {caps: ["compute", "ui", "timers"]},
    app: {caps: ["compute", "ui", "persist", "api", "network", "embed", "libs", "timers", "watch", "write", "self", "bind", "channel", "av"]},
};

// Plugin-registered presets (notes/09 SPI step 2). Looked up after the built-ins,
// so a plugin can add a block type that shows up in the editor's preset picker.
const customPresets = new Map<string, SuperBlockPreset>();
export const registerPreset = (id: string, preset: SuperBlockPreset) => customPresets.set(id, preset);
export const getPreset = (kind: string): SuperBlockPreset | undefined => customPresets.get(kind) || PRESETS[kind];
export const listPresets = (): string[] => {
    const ids = Object.keys(PRESETS);
    customPresets.forEach((_v, k) => {
        if (!ids.includes(k)) {
            ids.push(k);
        }
    });
    return ids;
};

// --- Feature layer (notes/14, L2) -------------------------------------------
// A feature is a named definition that bundles capabilities + a config schema +
// a run(ctx, config). A block in FEATURE mode (custom-sb-kind names a feature)
// runs the feature with its parsed config instead of raw code. The calendar etc.
// become features. Field types in configSchema drive the auto-generated form (L3).
export type ConfigField =
    | {key: string; label: string; type: "text" | "number" | "checkbox" | "date" | "block-ref" | "code"}
    | {key: string; label: string; type: "select"; options: {value: string; label: string}[]}
    | {key: string; label: string; type: "av-database"}
    | {key: string; label: string; type: "av-column"; ofKey: string};

export interface SuperBlockFeature {
    id: string;
    label: string;
    caps: Capability[];
    run: (ctx: SuperBlockCtx, config: Record<string, unknown>) => void;
    configSchema?: ConfigField[];
    defaultConfig?: Record<string, unknown>;
    icon?: string;
    pluginId?: string;
}

const features = new Map<string, SuperBlockFeature>();
export const registerFeature = (def: SuperBlockFeature) => features.set(def.id, def);
export const getFeature = (id: string): SuperBlockFeature | undefined => features.get(id);
export const listFeatures = (): SuperBlockFeature[] => Array.from(features.values());

// --- Property components (notes/16) -----------------------------------------
// A value-level extension bound to ONE property/column: renders + edits a richer
// value than the raw cell. The canonical native column stays a plain date/text;
// the cohesive part lives in a self-describing JSON companion column ($schema +
// _type). No new native AV type, no kernel fork. Reused across views (table cell,
// calendar-chip popover, form field). Reads/writes go through gated ctx.av.
export interface SuperBlockProperty {
    id: string;
    label: string;
    baseType: string;                                  // native type of the CANONICAL column ("date" | "text" | …)
    metaSchemaId?: string;                             // matches the "$schema" id in the companion JSON
    configSchema?: ConfigField[];                      // no-code form (which columns are canonical / companion)
    render?: (cell: unknown, meta: unknown) => HTMLElement;   // table cell / calendar-chip popover
    edit?: (cell: unknown, meta: unknown) => HTMLElement;     // full editor (incl. simplified quick-form)
    parse?: (raw: string) => unknown;                  // companion text → structured meta
    serialize?: (meta: unknown) => string;             // structured meta → companion text
    pluginId?: string;
}

const properties = new Map<string, SuperBlockProperty>();
export const registerProperty = (def: SuperBlockProperty) => properties.set(def.id, def);
export const getProperty = (id: string): SuperBlockProperty | undefined => properties.get(id);
export const listProperties = (): SuperBlockProperty[] => Array.from(properties.values());

// Lifecycle event bus (notes/09 SPI step 3). Plugins subscribe via the SPI's
// on(); the runtime emits at mount/unmount/error/write/grant/render.
export type SuperBlockEvent = "mounted" | "unmounted" | "error" | "write" | "grant" | "render";
export interface SuperBlockEventData { blockId: string; kind?: string; detail?: unknown; }
const eventListeners = new Map<SuperBlockEvent, Set<(e: SuperBlockEventData) => void>>();
export const onSuperBlockEvent = (event: SuperBlockEvent, handler: (e: SuperBlockEventData) => void): {dispose: () => void} => {
    let set = eventListeners.get(event);
    if (!set) {
        set = new Set();
        eventListeners.set(event, set);
    }
    set.add(handler);
    return {dispose: () => { set!.delete(handler); }};
};
const emit = (event: SuperBlockEvent, data: SuperBlockEventData) => {
    eventListeners.get(event)?.forEach((h) => {
        try {
            h(data);
        } catch (e) {
            // a faulty listener must not break the runtime
        }
    });
};

// Allowlisted libraries for ctx.require — pinned CDN builds and the global each
// one exposes. The allowlist IS the control: a block can only load these.
const LIB_ALLOW: Record<string, {url: string; global: string}> = {
    chartjs: {url: "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js", global: "Chart"},
    d3: {url: "https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js", global: "d3"},
    dayjs: {url: "https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.10/dayjs.min.js", global: "dayjs"},
};

// Per-host disposables: everything a block mounts that must be torn down when the
// block re-renders or is removed — nested editors (embed), timers, and explicit
// onUnmount callbacks. One registry keeps teardown in a single place.
interface HostDisposables {
    editors: Array<{destroy: () => void}>;
    timers: number[];
    unmounts: Array<() => void>;
}
const hostDisposables = new WeakMap<HTMLElement, HostDisposables>();
// Last-rendered signature per host, for the idempotent-render guard (Seq 4).
const hostSignatures = new WeakMap<HTMLElement, string>();
// In-doc pub/sub channels for ctx.channel — name -> subscriber callbacks.
const channelBus = new Map<string, Set<(data: unknown) => void>>();
const getDisposables = (host: HTMLElement): HostDisposables => {
    let d = hostDisposables.get(host);
    if (!d) {
        d = {editors: [], timers: [], unmounts: []};
        hostDisposables.set(host, d);
    }
    return d;
};

// Tear down everything a block mounted into `host`. Called on re-render and, via
// the removal observer in superblockRender, when a super-block is deleted (P9).
export const disposeSuperBlock = (host: HTMLElement) => {
    const d = hostDisposables.get(host);
    if (!d) {
        return;
    }
    d.timers.forEach((t) => {
        clearTimeout(t);
        clearInterval(t);
    });
    d.unmounts.forEach((cb) => {
        try {
            cb();
        } catch (e) {
            // ignore teardown errors
        }
    });
    d.editors.forEach((p) => {
        try {
            p.destroy();
        } catch (e) {
            // ignore teardown errors
        }
    });
    hostDisposables.delete(host);
};

// Emit "unmounted" for a host that was genuinely removed from the doc. Called by
// the removal observer (true deletion) — NOT by disposeSuperBlock, which also
// runs on re-render teardown. So "unmounted" reliably means gone, not re-rendered,
// and fires even for blocks that had no disposables.
export const emitUnmounted = (host: HTMLElement) => {
    const blockId = host.closest("[data-node-id]")?.getAttribute("data-node-id") || "";
    emit("unmounted", {blockId});
};

const SB_STATE = "custom-sb-state";

// Debounce persisted-state writes per block: ctx.state.set updates the DOM
// attribute synchronously (so a re-render sees it), but the kernel write is
// coalesced — a fast counter that calls set() many times in a row produces one
// setBlockAttrs, not dozens. The latest JSON always wins.
const pendingStateWrites = new Map<string, {json: string; timer: number}>();
const scheduleStateWrite = (blockId: string, json: string) => {
    const existing = pendingStateWrites.get(blockId);
    if (existing) {
        clearTimeout(existing.timer);
    }
    const timer = window.setTimeout(() => {
        pendingStateWrites.delete(blockId);
        fetchPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {[SB_STATE]: json}});
    }, 300);
    pendingStateWrites.set(blockId, {json, timer});
};

// Compile-once cache (step 6a): a block's code is turned into a Function once and
// reused across re-renders/reloads of the same source. Keyed by the code string,
// so identical code (common when the same preset is used repeatedly) compiles
// once. Capped to avoid unbounded growth as code is edited.
const compiled = new Map<string, (ctx: SuperBlockCtx) => void>();
const compile = (code: string): (ctx: SuperBlockCtx) => void => {
    let fn = compiled.get(code);
    if (!fn) {
        if (compiled.size > 200) {
            compiled.clear();
        }
        // eslint-disable-next-line no-new-func
        fn = new Function("ctx", code) as (ctx: SuperBlockCtx) => void;
        compiled.set(code, fn);
    }
    return fn;
};

// Read-only kernel endpoints a super-block may call via ctx.api.post. Anything
// that mutates the vault is intentionally excluded — block code should not be
// able to silently rewrite other blocks.
const API_ALLOW = [
    "/api/query/sql",
    "/api/block/getBlockInfo",
    "/api/block/getBlockKramdown",
    "/api/attr/getBlockAttrs",
];

// Mutating endpoints a super-block may call via ctx.api.write. Intentionally
// excludes deletes and notebook ops — a block can update/insert/attribute, not
// destroy. Gated by the "write" capability + a per-block confirm; every call is
// logged (audit). This is what lets a block ACT (e.g. mark a task done).
const WRITE_ALLOW = [
    "/api/attr/setBlockAttrs",
    "/api/block/updateBlock",
    "/api/block/insertBlock",
    "/api/block/appendBlock",
    "/api/block/prependBlock",
];

// First-use confirm, now persisted (policy.ts → localStorage, per device). Once
// the user allows `label` for `blockId` it is remembered across reloads. `label`
// is "api" or "network:<host>" (per-domain → doubles as the network allowlist).
const ensureGrant = (blockId: string, label: string, desc: string): Promise<boolean> => {
    if (hasGrant(blockId, label)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        confirmDialog(
            `Super-block — allow ${label}?`,
            `Block …${blockId.slice(-6)} wants to <b>${desc}</b>. ` +
            `Allow? (remembered on this device)`,
            () => {
                addGrant(blockId, label);
                emit("grant", {blockId, detail: {label}});
                resolve(true);
            },
            () => resolve(false),
        );
    });
};

// A capability provider augments `ctx` for blocks whose preset enables its name.
// Built-ins are seeded into CAP_PROVIDERS below; the plugin SPI (notes/09) will
// register additional providers into the same map via registerCapability.
interface CapEnv {
    ctx: SuperBlockCtx;
    blockId: string;
    host: HTMLElement;
}
type CapProvider = (env: CapEnv) => void;

export const CAP_PROVIDERS = new Map<string, CapProvider>([
    ["ui", ({ctx, host}) => {
        ctx.el = host;
        ctx.open = (id: string, newWindow?: boolean) => {
            if (!id) { return; }
            if (newWindow) { openNewWindowById(id); return; }
            const app = getAllEditor()[0]?.protyle?.app;
            if (app) { openFileById({app, id, action: [Constants.CB_GET_FOCUS, Constants.CB_GET_HL]}); }
        };
    }],
    ["persist", ({ctx, blockId, host}) => {
        // The IAL lives on the NodeHTMLBlock element, not the inner host.
        const blockEl = host.closest("[data-node-id]") as HTMLElement | null;
        let store: Record<string, unknown> = {};
        const raw = blockEl?.getAttribute(SB_STATE);
        if (raw) {
            try {
                store = JSON.parse(raw);
            } catch {
                store = {};
            }
        }
        ctx.state = {
            get: <T = unknown>(key: string) => store[key] as T | undefined,
            set: (key: string, value: unknown) => {
                store[key] = value;
                const json = JSON.stringify(store);
                if (blockEl) {
                    blockEl.setAttribute(SB_STATE, json); // sync: re-render sees it
                    scheduleStateWrite(blockId, json);     // debounced kernel write
                }
            },
        };
    }],
    ["api", ({ctx, blockId}) => {
        ctx.api = ctx.api || {};
        ctx.api.post = async (path: string, body?: object): Promise<IWebSocketData> => {
            if (!API_ALLOW.includes(path)) {
                throw new Error(`api: endpoint not allowed (${path})`);
            }
            if (!(await ensureGrant(blockId, "api", "read from the SiYuan kernel"))) {
                throw new Error("api: denied by user");
            }
            return fetchSyncPost(path, body || {});
        };
    }],
    ["write", ({ctx, blockId}) => {
        ctx.api = ctx.api || {};
        ctx.api.write = async (path: string, body?: object): Promise<IWebSocketData> => {
            if (!WRITE_ALLOW.includes(path)) {
                throw new Error(`api.write: endpoint not allowed (${path})`);
            }
            if (!(await ensureGrant(blockId, "write", "modify your vault (write to the kernel)"))) {
                throw new Error("write: denied by user");
            }
            // Audit: every write a block performs is logged + emitted.
            console.log("[super-block write]", blockId.slice(-6), path, body);
            emit("write", {blockId, detail: {path}});
            return fetchSyncPost(path, body || {});
        };
    }],
    ["network", ({ctx, blockId}) => {
        ctx.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            // Per-domain grant: the host the block wants to reach is what's
            // confirmed and remembered, so each new domain re-prompts.
            const rawUrl = typeof input === "string" ? input
                : input instanceof URL ? input.href
                    : (input as Request).url;
            let host: string;
            try {
                host = new URL(rawUrl, location.href).host;
            } catch {
                throw new Error("network: invalid URL");
            }
            if (!(await ensureGrant(blockId, `network:${host}`, `fetch from ${host}`))) {
                throw new Error("network: denied by user");
            }
            return fetch(input, init);
        };
    }],
    ["embed", ({ctx, host}) => {
        ctx.embed = (targetBlockId: string, container?: HTMLElement) => {
            const parent = container || host;
            const editors = getAllEditor();
            const base = editors[0];
            if (!base) {
                const note = document.createElement("div");
                note.textContent = "embed: no editor available";
                parent.appendChild(note);
                return;
            }
            const wrap = document.createElement("div");
            wrap.className = "sb-embed";
            parent.appendChild(wrap);
            // Construct via the existing editor's class (avoids a hard import +
            // import cycle); app comes from that editor's IProtyle.
            const ProtyleCtor = base.constructor as new (
                app: typeof base.protyle.app, el: HTMLElement, opts: object,
            ) => {destroy: () => void};
            const nested = new ProtyleCtor(base.protyle.app, wrap, {
                blockId: targetBlockId,
                // CB_GET_ALL zooms to just this block's subtree (not its siblings),
                // so embedding a block from the same doc doesn't pull the embed
                // block back in and recurse.
                action: [Constants.CB_GET_ALL],
                render: {background: false, title: false, gutter: true, scroll: false, breadcrumb: true},
            });
            // DUAL-ID FIX (editable-embed findings): the nested editor's DOM lives
            // inside the HOST doc's protyle, so editing events bubble up to the host's
            // input pipeline (input.ts querySelectorAll by data-node-id) and get applied
            // a SECOND time → doubled letters / cursor jumps. Stop the text-mutation
            // events at the wrapper so only the nested protyle (below it) handles them.
            // keydown/keyup still bubble so editor shortcuts keep working.
            // Includes keydown/keyup so Enter/Backspace aren't applied a second time
            // by the host (which would split the block twice → "double Enter"). The
            // nested protyle's own handlers sit BELOW the wrapper, so they still fire.
            ["input", "beforeinput", "compositionstart", "compositionupdate", "compositionend", "keydown", "keyup"].forEach((type) => {
                wrap.addEventListener(type, (e) => e.stopPropagation());
            });
            getDisposables(host).editors.push(nested);
        };
        // Isolated iframe embed — a separate browsing context, so the host's input
        // pipeline can never touch it (no dual-id/double-Enter/refresh). Loads the
        // SiYuan single-window page focused on the target block.
        ctx.embedFrame = (targetBlockId: string, container?: HTMLElement) => {
            const parent = container || host;
            fetchSyncPost("/api/block/getBlockInfo", {id: targetBlockId}).then((res) => {
                const d = res.data as {rootTitle?: string; rootIcon?: string; box?: string; rootID?: string} | null;
                if (!d) { parent.appendChild(document.createTextNode("(block not found)")); return; }
                const tab = [{
                    title: d.rootTitle, docIcon: d.rootIcon, pin: false, active: true, instance: "Tab", action: "Tab",
                    children: {
                        notebookId: d.box, blockId: targetBlockId, rootId: d.rootID, mode: "wysiwyg", instance: "Editor",
                        action: d.rootID === targetBlockId ? Constants.CB_GET_SCROLL : Constants.CB_GET_ALL,
                    },
                }];
                const url = `${window.location.protocol}//${window.location.host}/stage/build/app/window.html?v=${Constants.SIYUAN_VERSION}&json=${encodeURIComponent(JSON.stringify(tab))}`;
                const frame = document.createElement("iframe");
                frame.src = url;
                frame.style.cssText = "width:100%;height:420px;border:1px solid var(--b3-border-color);border-radius:6px";
                parent.appendChild(frame);
            });
        };
    }],
    ["timers", ({ctx, host}) => {
        const d = getDisposables(host);
        ctx.setInterval = (handler: () => void, ms: number): number => {
            const id = window.setInterval(handler, ms);
            d.timers.push(id);
            return id;
        };
        ctx.setTimeout = (handler: () => void, ms: number): number => {
            const id = window.setTimeout(handler, ms);
            d.timers.push(id);
            return id;
        };
        ctx.onUnmount = (cb: () => void) => {
            d.unmounts.push(cb);
        };
    }],
    ["watch", ({ctx, host}) => {
        ctx.watch = (cb: () => void) => {
            const d = getDisposables(host);
            let timer = 0;
            const handler = () => {
                clearTimeout(timer);
                timer = window.setTimeout(cb, 500); // debounce bursts of changes
            };
            document.addEventListener("sb-ws-main", handler);
            d.unmounts.push(() => {
                document.removeEventListener("sb-ws-main", handler);
                clearTimeout(timer);
            });
        };
    }],
    ["self", ({ctx, blockId, host}) => {
        const blockEl = host.closest("[data-node-id]") as HTMLElement | null;
        const docId = host.closest(".protyle")?.querySelector(".protyle-title")?.getAttribute("data-node-id") || "";
        ctx.self = {
            id: blockId,
            docId,
            getAttr: (key: string) => blockEl?.getAttribute(key) ?? null,
            setAttr: (key: string, value: string) => {
                blockEl?.setAttribute(key, value);
                fetchPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {[key]: value}});
            },
        };
    }],
    ["av", ({ctx, blockId}) => {
        ctx.av = {
            read: async (avId: string) => {
                if (!(await ensureGrant(blockId, "av", "read your databases"))) {
                    throw new Error("av: denied by user");
                }
                const res = await fetchSyncPost("/api/av/renderAttributeView", {id: avId});
                const view = (res?.data as {view?: {columns?: unknown[]; rows?: unknown[]}})?.view || {};
                const viewType = (res?.data as {viewType?: string})?.viewType || "";
                return {columns: view.columns || [], rows: view.rows || [], viewType};
            },
            setCell: async (op) => {
                if (!(await ensureGrant(blockId, "write", "modify your vault (write to the kernel)"))) {
                    throw new Error("write: denied by user");
                }
                console.log("[super-block write] av-cell", blockId.slice(-6), op.avID, op.keyID);
                emit("write", {blockId, detail: {avCell: op.keyID}});
                // /api/transactions requires reqId (fetchSyncPost doesn't add it).
                return fetchSyncPost("/api/transactions", {
                    reqId: Date.now(),
                    transactions: [{
                        doOperations: [{action: "updateAttrViewCell", id: op.cellID, avID: op.avID, keyID: op.keyID, rowID: op.rowID, data: op.data}],
                        undoOperations: [],
                    }],
                });
            },
        };
    }],
    ["channel", ({ctx, host}) => {
        ctx.channel = (name: string) => ({
            emit: (data: unknown) => {
                channelBus.get(name)?.forEach((cb) => {
                    try {
                        cb(data);
                    } catch (e) {
                        // a faulty subscriber must not break the emitter
                    }
                });
            },
            on: (cb: (data: unknown) => void) => {
                let set = channelBus.get(name);
                if (!set) {
                    set = new Set();
                    channelBus.set(name, set);
                }
                set.add(cb);
                getDisposables(host).unmounts.push(() => set!.delete(cb));
            },
        });
    }],
    ["bind", ({ctx, blockId, host}) => {
        const blockEl = host.closest("[data-node-id]") as HTMLElement | null;
        ctx.bind = (attrKey, control) => {
            const isCheckbox = control instanceof HTMLInputElement && control.type === "checkbox";
            const apply = (v: string) => {
                if (isCheckbox) {
                    (control as HTMLInputElement).checked = v === "true";
                } else if (control.value !== v) {
                    control.value = v;
                }
            };
            // initial: control reflects the stored attribute
            const initial = blockEl?.getAttribute(attrKey);
            if (initial != null) {
                apply(initial);
            }
            // control -> attribute (debounced kernel write)
            let timer = 0;
            const write = () => {
                const value = isCheckbox ? String((control as HTMLInputElement).checked) : control.value;
                blockEl?.setAttribute(attrKey, value);
                clearTimeout(timer);
                timer = window.setTimeout(
                    () => fetchPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {[attrKey]: value}}), 300);
            };
            control.addEventListener("input", write);
            control.addEventListener("change", write);
            // attribute -> control on external change (don't clobber while editing)
            const sync = () => {
                if (document.activeElement === control) {
                    return;
                }
                const v = blockEl?.getAttribute(attrKey);
                if (v != null) {
                    apply(v);
                }
            };
            const onWs = () => window.setTimeout(sync, 50);
            document.addEventListener("sb-ws-main", onWs);
            getDisposables(host).unmounts.push(() => document.removeEventListener("sb-ws-main", onWs));
        };
    }],
    ["libs", ({ctx}) => {
        ctx.require = (name: string): Promise<unknown> => {
            const lib = LIB_ALLOW[name];
            if (!lib) {
                return Promise.reject(new Error(`require: library not allowed (${name})`));
            }
            return addScript(lib.url, `sb-lib-${name}`)
                .then(() => (window as unknown as Record<string, unknown>)[lib.global]);
        };
    }],
]);

// Register a plugin-provided capability (notes/09 SPI). The provider augments
// ctx for any preset that lists `name`; it stays behind the same user gates.
export const registerCapability = (name: string, provider: CapProvider) => CAP_PROVIDERS.set(name, provider);

// Build the gated ctx by running each enabled capability's provider. "compute"
// has no provider (it's the baseline). Unknown caps are skipped. This loop is the
// single extension point the plugin SPI will hook (notes/09).
const buildCtx = (blockId: string, host: HTMLElement, caps: Capability[]): SuperBlockCtx => {
    const ctx: SuperBlockCtx = {blockId};
    const env: CapEnv = {ctx, blockId, host};
    caps.forEach((cap) => {
        const provider = CAP_PROVIDERS.get(cap);
        if (provider) {
            provider(env);
        }
    });
    return ctx;
};

// Runs one super-block: builds the gated ctx, compiles the code once, executes it.
// Errors are contained — a throwing block shows an inline message, never breaks the doc.
export const runSuperBlock = (host: HTMLElement, blockId: string, kind: string, code: string, configRaw?: string) => {
    // FEATURE mode if `kind` names a registered feature; else raw-code (preset) mode.
    const feature = getFeature(kind);
    // Idempotent re-render (Seq 4): signature covers everything that affects output —
    // kind, policy, and either the config (feature mode) or the code (raw mode).
    const signature = `${kind}\n${policySignature()}\n${feature ? (configRaw || "") : code}`;
    if (hostSignatures.get(host) === signature && host.childNodes.length > 0) {
        return;
    }
    const firstMount = !hostSignatures.has(host);
    hostSignatures.set(host, signature);
    // Destroy any nested editors from a previous mount before clearing the host.
    disposeSuperBlock(host);
    host.innerHTML = "";
    // Global kill-switch (policy.ts): no super-block code runs at all.
    if (isKilled()) {
        host.textContent = `super-block (${kind}) — disabled by settings`;
        return;
    }
    const finish = () => {
        emit("render", {blockId, kind});
        if (firstMount) {
            emit("mounted", {blockId, kind});
        }
    };
    if (feature) {
        try {
            const ctx = buildCtx(blockId, host, effectiveCaps(feature.caps));
            let config: Record<string, unknown> = {...(feature.defaultConfig || {})};
            if (configRaw) {
                try {
                    config = {...config, ...JSON.parse(configRaw)};
                } catch {
                    // bad config JSON — fall back to defaults
                }
            }
            ctx.config = config;
            feature.run(ctx, config);
            finish();
        } catch (e) {
            host.textContent = `super-block error: ${(e as Error).message}`;
            emit("error", {blockId, kind, detail: (e as Error).message});
        }
        return;
    }
    // Raw-code (preset) mode.
    const preset = getPreset(kind) || PRESETS.calc;
    if (!code) {
        host.textContent = `super-block (${kind}) — no code`;
        return;
    }
    try {
        // Drop globally-disabled capabilities before building ctx, so a disabled
        // cap is simply absent (gating by omission) rather than confirm-gated.
        const caps = effectiveCaps(preset.caps);
        const fn = compile(code);
        fn(buildCtx(blockId, host, caps));
        finish();
    } catch (e) {
        host.textContent = `super-block error: ${(e as Error).message}`;
        emit("error", {blockId, kind, detail: (e as Error).message});
    }
};

// --- Programmatic control (notes/09 SPI step 4) -----------------------------
// Lets a plugin create and drive super-blocks without the editor UI.

const findSuperBlock = (blockId: string): HTMLElement | null =>
    document.querySelector(`[data-node-id="${blockId}"][data-type="NodeHTMLBlock"]`);

export const rerenderSuperBlock = (blockId: string) => {
    const el = findSuperBlock(blockId);
    if (el) {
        el.removeAttribute("data-sb-rendered");
        superblockRender(el);
    }
};

// Insert a new super-block under `parentId`; resolves to the new block id.
export const insertSuperBlock = async (
    opts: {parentId: string; kind: string; code: string; state?: object},
): Promise<string> => {
    const nodeId = Lute.NewNodeID();
    const escCode = Lute.EscapeHTMLStr(opts.code);
    const stateAttr = opts.state
        ? ` ${SB_STATE}="${Lute.EscapeHTMLStr(JSON.stringify(opts.state))}"`
        : "";
    const dom = `<div data-node-id="${nodeId}" data-type="NodeHTMLBlock" class="render-node" data-subtype="block" ${SB_MARKER}="${opts.kind}" ${SB_CODE}="${escCode}"${stateAttr}>${genIconHTML()}<div><protyle-html data-content=""></protyle-html><span style="position: absolute">${Constants.ZWSP}</span></div><div class="protyle-attr" contenteditable="false"></div></div>`;
    const res = await fetchSyncPost("/api/block/insertBlock", {dataType: "dom", data: dom, parentID: opts.parentId});
    try {
        return (res.data[0].doOperations[0].id as string) || nodeId;
    } catch {
        return nodeId;
    }
};

// Update a super-block's preset/code, persist, and re-render in place.
export const updateSuperBlock = async (blockId: string, patch: {kind?: string; code?: string}): Promise<void> => {
    const attrs: Record<string, string> = {};
    if (patch.kind !== undefined) {
        attrs[SB_MARKER] = patch.kind;
    }
    if (patch.code !== undefined) {
        attrs[SB_CODE] = patch.code;
    }
    if (Object.keys(attrs).length === 0) {
        return;
    }
    await fetchSyncPost("/api/attr/setBlockAttrs", {id: blockId, attrs});
    const el = findSuperBlock(blockId);
    if (el) {
        Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
        rerenderSuperBlock(blockId);
    }
};

export const getSuperBlockState = async (blockId: string): Promise<Record<string, unknown>> => {
    const res = await fetchSyncPost("/api/attr/getBlockAttrs", {id: blockId});
    const raw = (res?.data as Record<string, string> | undefined)?.[SB_STATE];
    if (!raw) {
        return {};
    }
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

export const setSuperBlockState = async (blockId: string, state: Record<string, unknown>): Promise<void> => {
    const json = JSON.stringify(state);
    await fetchSyncPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {[SB_STATE]: json}});
    const el = findSuperBlock(blockId);
    if (el) {
        el.setAttribute(SB_STATE, json);
        rerenderSuperBlock(blockId);
    }
};
