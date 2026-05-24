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
// Rich-UI building blocks exposed through the "siyuan" capability so block code /
// plugins can show native toasts, dialogs, and context menus (see ctx.siyuan).
import {showMessage} from "../../dialog/message";
import {Dialog} from "../../dialog/index";
import {Menu} from "../../plugin/Menu";
import {EventBus} from "../../plugin/EventBus";
import {addScript} from "../util/addScript";
import {superblockRender, SB_MARKER, SB_CODE} from "../render/superblockRender";
import {parseEvery} from "./cron";
import {matchHotkey} from "./hotkey";
import {storagePath} from "./storage";
import {registerBlockDecorator, BlockDecorator} from "./blockDecorators";
import {addTopBar, addStatusBar, addSlashCommand, makeBlockMenuHandler, BlockMenuItem, SlashHost} from "./uiSurfaces";
import {registerExport, clearExport} from "./exportRegistry";
import {genIconHTML} from "../render/util";

// Tabs/command surfaces are backed by a real host Plugin (pluginHost.ts). That
// module imports plugin/index, so it is loaded LAZILY (dynamic import) to keep the
// heavy plugin/layout subsystem out of the early-loaded runtime's module-eval graph
// — a static import here reorders evaluation and can trip a latent circular dep,
// crashing app boot. Lazy import means the cost (and the cycle risk) only happens
// the first time a block actually opens a tab / registers a command.
const lazyOpenTab = (o: {title: string; icon?: string; render: (el: HTMLElement) => void; data?: unknown}): boolean => {
    import("./pluginHost").then((m) => m.surfaceOpenTab(o)).catch((e) => console.warn("[superblock] openTab failed", e));
    return true;
};
const lazyCommand = (o: {id: string; label: string; hotkey?: string; callback: () => void}): (() => void) => {
    let off: (() => void) | null = null;
    let cancelled = false;
    import("./pluginHost").then((m) => { if (!cancelled) { off = m.surfaceCommand(o); } }).catch((e) => console.warn("[superblock] command failed", e));
    return () => { cancelled = true; if (off) { off(); } };
};

export type Capability = "compute" | "ui" | "persist" | "api" | "network" | "embed" | "libs" | "timers" | "watch" | "write" | "self" | "bind" | "channel" | "av" | "siyuan" | "cron" | "command" | "assets" | "storage" | "clipboard" | "worker" | "events" | "decorate" | "surfaces" | "export" | "request";

export interface SuperBlockCtx {
    blockId: string;
    el?: HTMLElement; // present only when the "ui" capability is enabled
    // "ui" convenience: render shortcuts (return the host for chaining) and a
    // per-block console panel (ctx.console / ctx.log) for debugging output.
    text?: (s: unknown) => HTMLElement;
    html?: (s: unknown) => HTMLElement;
    console?: {log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void};
    log?: (...a: unknown[]) => void;
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
    // present with the "siyuan" capability — a broad toolbox of SiYuan frontend
    // abilities for power-user code/plugins: call ANY kernel API, open blocks, and
    // reach the Protyle class / app / Lute / all editors.
    siyuan?: {
        api: (endpoint: string, data?: object) => Promise<IWebSocketData>;        // await any /api/* endpoint
        apiCb: (endpoint: string, data: object, cb: (r: IWebSocketData) => void) => void;
        openBlock: (id: string, newWindow?: boolean) => void;
        constants: typeof Constants;
        lute: () => unknown;            // the global Lute markdown engine
        protyleClass: () => unknown;    // the Protyle editor constructor
        app: () => unknown;             // the SiYuan App instance
        getAllEditor: typeof getAllEditor;
        // The whole super-block SPI (window.siyuan.superblock): registerFeature/
        // registerProperty/registerCapability, insert/update/get|setState/rerender,
        // listFeatures/Properties/Presets, and the view/reminder/ics/nl engines.
        sb: unknown;
        // --- rich UI (native widgets) ---
        showMessage: typeof showMessage; // toast: showMessage("done"[, timeout, "info|error"])
        Dialog: typeof Dialog;           // modal dialog class: new ctx.siyuan.Dialog({title, content, …})
        Menu: typeof Menu;               // context menu class: new ctx.siyuan.Menu("id").addItem(…).open({x,y})
    };
    // present only when the "libs" capability is enabled. Lazy-loads an
    // allowlisted library from CDN (cached per session) and resolves to its
    // global, e.g. `const Chart = await ctx.require("chartjs")`.
    require?: (name: string) => Promise<unknown>;
    // present with the "libs" capability. Loads ANY ES module by URL (e.g.
    // "https://esm.sh/lodash") and resolves to its namespace object — unlocks the
    // whole library ecosystem. Cached per URL. (Runs remote code; treat as trusted.)
    import?: (url: string) => Promise<Record<string, unknown>>;
    // present with the "cron" capability. Schedules a background repeat on a human
    // interval ("30s", "5m", "1h", "1h30m", "2d", or ms). Runs regardless of the
    // block's scroll position; auto-cleared on unmount/removal. Returns a cancel fn.
    cron?: (every: string | number, fn: () => void) => () => void;
    // present with the "command" capability. Registers a keyboard shortcut
    // ("ctrl+k", "mod+s", "alt+1", …) that runs fn; auto-removed on unmount.
    command?: (hotkey: string, fn: () => void) => () => void;
    // present with the "assets" capability. Work with the vault's attachments:
    // upload a File/Blob (→ returns its asset path), read an asset's text, or get
    // its served URL.
    assets?: {
        upload: (file: File | Blob, dir?: string) => Promise<string>;
        read: (path: string) => Promise<string>;
        url: (path: string) => string;
    };
    // present with the "storage" capability. Persistent JSON key-value, stored in
    // the workspace and shared across blocks/reloads (vs "persist" = per-block IAL).
    storage?: {
        get: (key: string) => Promise<unknown>;
        set: (key: string, value: unknown) => Promise<void>;
        remove: (key: string) => Promise<void>;
    };
    // present with the "clipboard" capability. Read/write the system clipboard.
    clipboard?: {
        writeText: (text: string) => Promise<void>;
        readText: () => Promise<string>;
    };
    // present with the "worker" capability. Run a SELF-CONTAINED function in a
    // background Web Worker (off the main thread) with a structured-cloneable input,
    // resolving to its result. The fn can't use closures/DOM (it runs isolated).
    worker?: (fn: (input: unknown) => unknown, input?: unknown) => Promise<unknown>;
    // present with the "events" capability. Subscribe to SiYuan frontend events
    // ("ws-main", "switch-protyle", "loaded-protyle-static", "sync-end", …); the
    // handler gets the CustomEvent (use e.detail). Auto-unsubscribed on unmount.
    on?: (event: string, handler: (e: CustomEvent) => void) => () => void;
    // present with the "decorate" capability. Augment EXISTING native blocks in
    // place: match(blockEl) → decorate(blockEl) (inject UI/behavior, read/write the
    // block). Applies to current + future blocks; auto-unregistered on unmount.
    decorate?: (def: BlockDecorator) => () => void;
    // present with the "surfaces" capability. Add APP-LEVEL UI outside this block:
    // a top-bar icon, a status-bar item, a slash (/) command, a native block-menu
    // item, a command-palette entry, or open a custom TAB. Each returns an
    // unregister fn (openTab returns a boolean — tabs are closed via the tab UI) and
    // is auto-removed on unmount where applicable. (Docks still need layout-init
    // registration and are intentionally not exposed here.)
    surfaces?: {
        topBar: (o: {icon: string; title: string; position?: "left" | "right"; onclick: (e: MouseEvent) => void}) => () => void;
        statusBar: (o: {html?: string; element?: HTMLElement; position?: "left" | "right"; onclick?: (e: MouseEvent) => void}) => () => void;
        slashCommand: (o: {id: string; name: string; html?: string; run: (protyle: unknown, nodeElement: HTMLElement) => void}) => () => void;
        // Add an item to the right-click (gutter) menu of EXISTING native blocks.
        // `match(blockEl)` gates which blocks show it (default: all); `click` fires
        // with the matched block element. Auto-removed on unmount.
        blockMenu: (o: BlockMenuItem) => () => void;
        // Open a custom tab whose body is rendered by render(el). Backed by a real
        // host Plugin's addTab + openFile — behaves like any plugin tab. Returns true
        // if opened (false if the layout isn't ready yet).
        openTab: (o: {title: string; icon?: string; render: (el: HTMLElement) => void; data?: unknown}) => boolean;
        // Add a searchable command-palette entry (optionally hotkeyed). Returns an
        // unregister fn; auto-removed on unmount.
        command: (o: {id: string; label: string; hotkey?: string; callback: () => void}) => () => void;
    };
    // present with the "export" capability. Declare a STATIC representation the
    // block contributes to copies/exports (instead of its live interactive output).
    // The content is mirrored into the block's own <protyle-html data-content> on
    // render. With {persist:true} it is ALSO saved to the block's custom-sb-export
    // IAL attr (gated write) so it survives reload/sync and is API/SQL-legible.
    // Returns an unregister fn; auto-cleared on unmount.
    onExport?: (fn: () => string, opts?: {persist?: boolean}) => () => void;
    // present with the "request" capability. Ask for a capability NOT in this
    // block's preset; the user is prompted to grant it for this block. On grant the
    // cap's provider runs against the live ctx (so ctx.<cap> becomes available) and
    // resolves true; declined resolves false. Lets a small block escalate on demand.
    requestCapability?: (name: Capability | string) => Promise<boolean>;
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
        // Add a column (key) to a database; returns the new key id. Gated by write.
        addColumn: (op: {avID: string; name?: string; type?: string; previousID?: string}) => Promise<string>;
        // Escape hatch: run ANY kernel transaction (add rows/views, etc.). Gated by write.
        tx: (doOperations: Array<Record<string, unknown>>) => Promise<IWebSocketData>;
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
    app: {caps: ["compute", "ui", "persist", "api", "network", "embed", "libs", "timers", "watch", "write", "self", "bind", "channel", "av", "siyuan", "cron", "command", "assets", "storage", "clipboard", "worker", "events", "decorate", "surfaces", "export", "request"]},
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
// Load ANY ES module by URL via an injected module-script (handles absolute URLs +
// the module's own deps; cached per URL). Resolves to the module's namespace object,
// e.g. lodash from esm.sh → use `.default`. Runs remote code — treat as trusted.
const esmCache = new Map<string, Promise<Record<string, unknown>>>();
const importEsm = (url: string): Promise<Record<string, unknown>> => {
    const cached = esmCache.get(url);
    if (cached) { return cached; }
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
        const w = window as unknown as Record<string, unknown>;
        const cb = "__sbimp" + Math.random().toString(36).slice(2);
        const s = document.createElement("script");
        const timer = window.setTimeout(() => { reject(new Error("import timed out: " + url)); cleanup(); }, 20000);
        const cleanup = () => { clearTimeout(timer); delete w[cb]; s.remove(); };
        w[cb] = (m: Record<string, unknown> | null, err: string | null) => {
            if (err) { reject(new Error("import failed: " + url + " — " + err)); }
            else { resolve(m || {}); }
            cleanup();
        };
        s.type = "module";
        s.textContent = `import(${JSON.stringify(url)}).then(m=>window[${JSON.stringify(cb)}](m,null)).catch(e=>window[${JSON.stringify(cb)}](null,String((e&&e.message)||e)));`;
        document.head.appendChild(s);
    });
    esmCache.set(url, p);
    return p;
};

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

// Generate a SiYuan-format id (YYYYMMDDHHmmss-<7 base36>) without depending on Lute.
const newSyId = (): string => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 9)}`;
};

// Shared EventBus for the "events" capability. SiYuan emits frontend events to
// every entry in window.siyuan.plugins[].eventBus, so we register one minimal
// pseudo-plugin (lazily, once) whose bus super-block code can subscribe to. The
// extra fields are kept defined so code iterating plugins won't choke on it.
// The shared pseudo-plugin object that lives in window.siyuan.plugins. SiYuan
// iterates that array for event dispatch AND slash-command aggregation, so a single
// minimal entry lets super-block code both subscribe to frontend events (its
// eventBus) and register slash commands (its protyleSlash). Created lazily, once.
let sbPlugin: (Record<string, unknown> & {eventBus: EventBus; protyleSlash: SlashHost["protyleSlash"]; name: string}) | null = null;
const ensureSbPlugin = () => {
    if (sbPlugin) { return sbPlugin; }
    const w = window.siyuan as unknown as {plugins?: Array<Record<string, unknown>>};
    if (!w.plugins) { w.plugins = []; }   // SiYuan leaves this undefined when no plugins are installed
    sbPlugin = {
        name: "__superblock-events__", eventBus: new EventBus("__superblock-events__"),
        commands: [], models: {}, topBarIcons: [], statusBarIcons: [], docks: {},
        protyleSlash: [], protyleOptions: {}, setting: undefined, data: {},
        onload: () => undefined, onunload: () => undefined, onLayoutReady: () => undefined, uninstall: () => undefined,
    };
    w.plugins.push(sbPlugin);
    return sbPlugin;
};
const ensureSbEventBus = (): EventBus | null => ensureSbPlugin().eventBus;
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
// User code is compiled as an ASYNC function body, so top-level `await` works
// (e.g. `const r = await ctx.siyuan.api("/api/...")`). Errors surface as a rejected
// promise, handled at the call site.
//
// IMPORTANT: derive the AsyncFunction constructor from a RUNTIME STRING, not a
// literal like `async () => {}`. The bundler down-levels async literals in our
// source to plain functions, so `(async()=>{}).constructor` would resolve to the
// ordinary Function — and `await` in user code would be a SyntaxError again. The
// string below is parsed natively by the browser at runtime (never transpiled), so
// it yields the genuine AsyncFunction constructor.
// eslint-disable-next-line no-new-func
const AsyncFunction = (Function("return (async function(){}).constructor")()) as
    new (arg: string, body: string) => (ctx: SuperBlockCtx) => Promise<void>;
const compiled = new Map<string, (ctx: SuperBlockCtx) => Promise<void> | void>();
const compile = (code: string): (ctx: SuperBlockCtx) => Promise<void> | void => {
    let fn = compiled.get(code);
    if (!fn) {
        if (compiled.size > 200) {
            compiled.clear();
        }
        // eslint-disable-next-line no-new-func
        fn = new AsyncFunction("ctx", code);
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

// Plugin allowlist contributions (SPI step 5). A registered plugin may EXTEND what
// blocks can reach: a read endpoint (ctx.api.post), a mutating endpoint (ctx.api.write
// — still behind the per-block "write" confirm + audit, never deletes), or a CDN
// library (ctx.require). Idempotent and additive only; nothing is removed at runtime,
// and every reach still passes the same per-capability user gate + kill-switch.
export const allowApiEndpoint = (path: string): void => { if (path && !API_ALLOW.includes(path)) { API_ALLOW.push(path); } };
export const allowWriteEndpoint = (path: string): void => { if (path && !WRITE_ALLOW.includes(path)) { WRITE_ALLOW.push(path); } };
export const allowLibrary = (name: string, spec: {url: string; global: string}): void => { if (name && spec && spec.url && spec.global) { LIB_ALLOW[name] = spec; } };

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
    ["ui", ({ctx, host, blockId}) => {
        ctx.el = host;
        // Render shortcuts (return the host so calls can chain).
        ctx.text = (s: unknown) => { host.textContent = String(s); return host; };
        ctx.html = (s: unknown) => { host.innerHTML = String(s); return host; };
        // Per-block dev tools: a faint "re-run / console" row + a collapsible console
        // panel, kept as siblings of the host (so they survive host re-renders/clears).
        const wrapper = host.parentElement;
        let panel = wrapper ? wrapper.querySelector(":scope > .sb-console") as HTMLElement | null : null;
        if (wrapper && !wrapper.querySelector(":scope > .sb-tools")) {
            const tools = document.createElement("div");
            tools.className = "sb-tools";
            tools.setAttribute("contenteditable", "false");
            tools.style.cssText = "display:flex;gap:10px;font-size:11px;opacity:.45;margin-top:2px;user-select:none";
            const rerun = document.createElement("span");
            rerun.textContent = "↻ re-run";
            rerun.style.cursor = "pointer";
            rerun.onclick = () => rerenderSuperBlock(blockId);
            const toggle = document.createElement("span");
            toggle.textContent = "▸ console";
            toggle.style.cursor = "pointer";
            toggle.onclick = () => { if (panel) { panel.style.display = panel.style.display === "none" ? "" : "none"; } };
            tools.append(rerun, toggle);
            wrapper.appendChild(tools);
        }
        if (wrapper && !panel) {
            panel = document.createElement("div");
            panel.className = "sb-console";
            panel.setAttribute("contenteditable", "false");
            panel.style.cssText = "display:none;font-family:var(--b3-font-family-code,monospace);font-size:11px;background:var(--b3-theme-surface);border:1px solid var(--b3-border-color);border-radius:4px;padding:4px 6px;margin-top:2px;max-height:160px;overflow:auto;white-space:pre-wrap";
            wrapper.appendChild(panel);
        }
        if (panel) { panel.innerHTML = ""; }   // clear log on each (re)run
        const write = (level: string, args: unknown[]) => {
            if (!panel) { return; }
            const line = document.createElement("div");
            if (level === "error") { line.style.color = "var(--b3-card-error-color, #d23)"; }
            else if (level === "warn") { line.style.color = "var(--b3-card-warning-color, #b80)"; }
            line.textContent = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
            panel.appendChild(line);
            panel.style.display = "";   // reveal the panel when something is logged
        };
        ctx.console = {log: (...a) => write("log", a), warn: (...a) => write("warn", a), error: (...a) => write("error", a)};
        ctx.log = ctx.console.log;
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
    ["siyuan", ({ctx}) => {
        const openBlock = (id: string, newWindow?: boolean) => {
            if (!id) { return; }
            if (newWindow) { openNewWindowById(id); return; }
            const app = getAllEditor()[0]?.protyle?.app;
            if (app) { openFileById({app, id, action: [Constants.CB_GET_FOCUS, Constants.CB_GET_HL]}); }
        };
        ctx.siyuan = {
            // Call ANY kernel endpoint (read or write). Unlike ctx.api (which is
            // allowlisted to read-only endpoints), this is the unrestricted toolbox —
            // only present on blocks that enable the "siyuan" capability.
            api: (endpoint: string, data?: object) => fetchSyncPost(endpoint, data || {}),
            apiCb: (endpoint: string, data: object, cb: (r: IWebSocketData) => void) => fetchPost(endpoint, data, cb),
            // Open/focus a block in the current tab, or a new window.
            openBlock,
            // SiYuan constants (event names, action modes, etc.).
            constants: Constants,
            // Lazily-resolved frontend internals (the editor must exist at call time):
            lute: () => (window as unknown as {Lute?: unknown}).Lute,             // markdown engine
            protyleClass: () => { const e = getAllEditor()[0]; return e ? e.constructor : undefined; },  // Protyle ctor
            app: () => getAllEditor()[0]?.protyle?.app,                            // App instance
            getAllEditor,                                                          // all open editors
            sb: (window.siyuan as unknown as {superblock?: unknown}).superblock,   // the full super-block SPI
            // Native UI widgets — show feedback without hand-rolling DOM:
            showMessage,   // toast notification
            Dialog,        // modal dialog (class)
            Menu,          // right-click / context menu (class)
        };
    }],
    ["command", ({ctx, host}) => {
        const d = getDisposables(host);
        ctx.command = (hotkey: string, fn: () => void): (() => void) => {
            const handler = (ev: KeyboardEvent) => {
                if (matchHotkey(hotkey, ev)) {
                    ev.preventDefault();
                    try { fn(); } catch (e) { console.warn("[superblock] command error", e); }
                }
            };
            document.addEventListener("keydown", handler);
            const off = () => document.removeEventListener("keydown", handler);
            d.unmounts.push(off);   // removed on unmount/removal
            return off;
        };
    }],
    ["assets", ({ctx}) => {
        ctx.assets = {
            // Upload a File/Blob to the vault assets folder; returns its asset path.
            upload: async (file: File | Blob, dir?: string): Promise<string> => {
                const fd = new FormData();
                fd.append("assetsDirPath", dir || "/assets/");
                fd.append("file[]", file);
                const res = await fetch("/api/asset/upload", {method: "POST", body: fd});
                const j = await res.json();
                const succ = j && j.data && j.data.succMap;
                return succ ? (Object.values(succ)[0] as string) : "";
            },
            read: (path: string) => fetch(path).then((r) => r.text()),
            url: (path: string) => path,
        };
    }],
    ["clipboard", ({ctx}) => {
        ctx.clipboard = {
            writeText: (text: string) => navigator.clipboard.writeText(text),
            readText: () => navigator.clipboard.readText(),
        };
    }],
    ["decorate", ({ctx, host}) => {
        ctx.decorate = (def: BlockDecorator): (() => void) => {
            const off = registerBlockDecorator(def);
            getDisposables(host).unmounts.push(off);
            return off;
        };
    }],
    ["surfaces", ({ctx, host}) => {
        const d = getDisposables(host);
        const track = (off: () => void): (() => void) => { d.unmounts.push(off); return off; };
        ctx.surfaces = {
            topBar: (o) => track(addTopBar(o)),
            statusBar: (o) => track(addStatusBar(o)),
            slashCommand: (o) => track(addSlashCommand(ensureSbPlugin() as unknown as SlashHost, o)),
            blockMenu: (o: BlockMenuItem) => {
                const bus = ensureSbEventBus();
                if (!bus) { return () => undefined; }
                const handler = makeBlockMenuHandler(o);
                bus.on("click-blockicon" as never, handler as never);
                return track(() => bus.off("click-blockicon" as never, handler as never));
            },
            openTab: (o) => lazyOpenTab(o),
            command: (o) => track(lazyCommand(o)),
        };
    }],
    ["export", ({ctx, blockId, host}) => {
        ctx.onExport = (fn: () => string, opts?: {persist?: boolean}): (() => void) => {
            registerExport(blockId, fn);
            const content = () => { try { return fn() || ""; } catch { return ""; } };
            // Mirror into the block's OWN <protyle-html data-content> so DOM-based
            // copy/export reflect it. Safe: only touches this block's attribute.
            try {
                const stock = host.parentElement?.querySelector("protyle-html") as HTMLElement | null;
                if (stock) { stock.setAttribute("data-content", content()); }
            } catch { /* ignore — a faulty provider must not break render */ }
            // Durable snapshot: persist to the block's OWN custom-sb-export IAL attr
            // (same own-block, fire-and-forget pattern as ctx.state). It then survives
            // reload/sync and is legible via the API + SQL. The render path restores it
            // into data-content on mount. (Inlining into kernel *markdown* export still
            // needs an export-path hook; this covers DOM/HTML/PDF export + round-trip.)
            if (opts && opts.persist) {
                try { fetchPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {"custom-sb-export": content()}}); } catch { /* ignore */ }
            }
            const off = () => clearExport(blockId);
            getDisposables(host).unmounts.push(off);
            return off;
        };
    }],
    ["request", ({ctx, blockId, host}) => {
        // Runtime capability escalation (notes/10 G). A block asks for a cap not in
        // its preset; on user grant, that cap's provider runs against THIS live ctx
        // (so ctx.<cap> appears) and the grant is remembered per device. "compute"
        // is the baseline (always available); unknown caps resolve false.
        ctx.requestCapability = (name: string): Promise<boolean> => {
            if (name === "compute") { return Promise.resolve(true); }
            const provider = CAP_PROVIDERS.get(name);
            if (!provider) { return Promise.resolve(false); }
            return ensureGrant(blockId, "cap:" + name, "use the “" + name + "” capability").then((ok) => {
                if (!ok) { return false; }
                try { provider({ctx, blockId, host}); } catch (e) { console.warn("[superblock] requestCapability failed", name, e); return false; }
                return true;
            });
        };
    }],
    ["events", ({ctx, host}) => {
        ctx.on = (event: string, handler: (e: CustomEvent) => void): (() => void) => {
            const bus = ensureSbEventBus();
            if (!bus) { return () => { /* no plugins host yet */ }; }
            bus.on(event as never, handler as never);
            const off = () => bus.off(event as never, handler as never);
            getDisposables(host).unmounts.push(off);
            return off;
        };
    }],
    ["worker", ({ctx, host}) => {
        ctx.worker = (fn: (input: unknown) => unknown, input?: unknown): Promise<unknown> =>
            new Promise((resolve, reject) => {
                const src = `self.onmessage=function(e){Promise.resolve((${fn.toString()})(e.data)).then(function(r){self.postMessage({r:r})}).catch(function(err){self.postMessage({err:String((err&&err.message)||err)})})}`;
                const url = URL.createObjectURL(new Blob([src], {type: "application/javascript"}));
                const wkr = new Worker(url);
                getDisposables(host).unmounts.push(() => { wkr.terminate(); URL.revokeObjectURL(url); });
                wkr.onmessage = (e: MessageEvent) => {
                    const d = e.data as {r?: unknown; err?: string};
                    wkr.terminate();
                    URL.revokeObjectURL(url);
                    if (d && d.err) { reject(new Error(d.err)); } else { resolve(d ? d.r : undefined); }
                };
                wkr.onerror = () => { wkr.terminate(); URL.revokeObjectURL(url); reject(new Error("worker error")); };
                wkr.postMessage(input);
            });
    }],
    ["storage", ({ctx}) => {
        ctx.storage = {
            set: async (key: string, value: unknown): Promise<void> => {
                const fd = new FormData();
                fd.append("path", storagePath(key));
                fd.append("isDir", "false");
                fd.append("file", new Blob([JSON.stringify(value)], {type: "application/json"}));
                await fetch("/api/file/putFile", {method: "POST", body: fd});
            },
            get: async (key: string): Promise<unknown> => {
                const res = await fetch("/api/file/getFile", {
                    method: "POST", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({path: storagePath(key)}),
                });
                if (!res.ok) { return null; }
                const t = await res.text();
                try {
                    const parsed = JSON.parse(t);
                    // getFile returns a {code:404,…} JSON for a missing file → treat as null.
                    if (parsed && typeof parsed === "object" && (parsed as {code?: number}).code === 404) { return null; }
                    return parsed;
                } catch { return null; }
            },
            remove: async (key: string): Promise<void> => {
                await fetch("/api/file/removeFile", {
                    method: "POST", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({path: storagePath(key)}),
                });
            },
        };
    }],
    ["cron", ({ctx, host}) => {
        const d = getDisposables(host);
        ctx.cron = (every: string | number, fn: () => void): (() => void) => {
            const ms = parseEvery(every);
            if (!ms) { return () => { /* invalid spec → no-op */ }; }
            const run = () => { try { fn(); } catch (e) { console.warn("[superblock] cron error", e); } };
            run();   // leading edge: run once immediately so the block isn't blank until the first interval
            const id = window.setInterval(run, ms);
            d.timers.push(id);   // reuse the timers disposal list → cleared on unmount/removal
            return () => clearInterval(id);
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
            addColumn: async (op) => {
                if (!(await ensureGrant(blockId, "write", "modify your vault (write to the kernel)"))) {
                    throw new Error("write: denied by user");
                }
                const id = newSyId();
                emit("write", {blockId, detail: {addColumn: op.avID}});
                await fetchSyncPost("/api/transactions", {
                    reqId: Date.now(),
                    transactions: [{
                        doOperations: [{action: "addAttrViewCol", avID: op.avID, name: op.name || "New Column", type: op.type || "text", id, previousID: op.previousID || ""}],
                        undoOperations: [],
                    }],
                });
                return id;
            },
            tx: async (doOperations) => {
                if (!(await ensureGrant(blockId, "write", "modify your vault (write to the kernel)"))) {
                    throw new Error("write: denied by user");
                }
                emit("write", {blockId, detail: {tx: doOperations.length}});
                return fetchSyncPost("/api/transactions", {reqId: Date.now(), transactions: [{doOperations, undoOperations: []}]});
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
        ctx.import = (url: string) => importEsm(url);
    }],
]);

// Register a plugin-provided capability (notes/09 SPI). The provider augments
// ctx for any preset that lists `name`; it stays behind the same user gates.
export const registerCapability = (name: string, provider: CapProvider) => CAP_PROVIDERS.set(name, provider);

// Introspection (dev/plugin tool): the live list of capability names a block can
// enable — "compute" (baseline, no provider) plus every registered provider.
export const listCapabilities = (): string[] => ["compute", ...Array.from(CAP_PROVIDERS.keys())];

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
// Styled inline error box (replaces plain red text). Shows the message + a hint.
const renderError = (host: HTMLElement, message: string) => {
    host.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--b3-card-error-color,#d23);border-radius:4px;padding:6px 8px;font-size:12px;color:var(--b3-card-error-color,#d23);background:var(--b3-card-error-background,rgba(210,40,40,.07))";
    box.textContent = "⚠ " + message;
    const hint = document.createElement("div");
    hint.style.cssText = "opacity:.7;font-size:11px;margin-top:2px";
    hint.textContent = "Open the ✎ editor to fix the code, or click ↻ re-run.";
    box.appendChild(hint);
    host.appendChild(box);
};

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
            renderError(host, (e as Error).message);
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
        const ret = fn(buildCtx(blockId, host, caps));
        finish();
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
            // Loading state: show "running…" while async code awaits, if nothing's
            // been rendered yet; removed once the promise settles.
            let loading: HTMLElement | null = null;
            if (!host.firstChild && !host.textContent) {
                loading = document.createElement("span");
                loading.textContent = "running…";
                loading.style.cssText = "opacity:.5;font-size:12px";
                host.appendChild(loading);
            }
            (ret as Promise<unknown>).then((val: unknown) => {
                if (loading && loading.parentNode === host) { host.removeChild(loading); }
                // Forgiving render: if the code RETURNED a string/number/Node and
                // didn't write to ctx.el itself, show it automatically — so
                // `return "hello"` or `return someElement` just works.
                if (val != null && !host.firstChild && !host.textContent) {
                    if (val instanceof Node) { host.appendChild(val); }
                    else if (typeof val === "string" || typeof val === "number") { host.textContent = String(val); }
                }
            }).catch((e: Error) => {
                // async user code: surface a rejection the same way as a sync throw.
                renderError(host, e.message);
                emit("error", {blockId, kind, detail: e.message});
            });
        }
    } catch (e) {
        renderError(host, (e as Error).message);
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
