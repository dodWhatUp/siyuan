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
import {effectiveCaps, isKilled, hasGrant, addGrant} from "./policy";
import {getAllEditor} from "../../layout/getAll";
import {Constants} from "../../constants";
import {addScript} from "../util/addScript";

export type Capability = "compute" | "ui" | "persist" | "api" | "network" | "embed" | "libs" | "timers";

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
    // present only when the "api" capability is enabled. Calls the SiYuan kernel,
    // restricted to a read-only endpoint allowlist. First use prompts a confirm.
    api?: {
        post: (path: string, body?: object) => Promise<IWebSocketData>;
    };
    // present only when the "network" capability is enabled. Pass-through to the
    // browser fetch after a first-use confirm; grants are per-domain (policy.ts),
    // which doubles as the network allowlist.
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    // present only when the "embed" capability is enabled. Mounts a REAL nested
    // Protyle editor for the target block into ctx.el — fully editable, unlike a
    // stock read-only embed. The nested editor is destroyed on re-render.
    embed?: (targetBlockId: string) => void;
    // present only when the "libs" capability is enabled. Lazy-loads an
    // allowlisted library from CDN (cached per session) and resolves to its
    // global, e.g. `const Chart = await ctx.require("chartjs")`.
    require?: (name: string) => Promise<unknown>;
    // present only when the "timers" capability is enabled. Like the globals, but
    // tracked and auto-cleared on unmount/re-render (no leaked intervals).
    setInterval?: (handler: () => void, ms: number) => number;
    setTimeout?: (handler: () => void, ms: number) => number;
    onUnmount?: (cb: () => void) => void;
}

// A preset is a named capability profile — the user-facing "block type".
export interface SuperBlockPreset {
    caps: Capability[];
}

export const PRESETS: Record<string, SuperBlockPreset> = {
    calc: {caps: ["compute", "ui"]},
    hello: {caps: ["compute", "ui"]},
    data: {caps: ["compute", "ui", "persist"]},
    embed: {caps: ["compute", "ui", "embed"]},
    viz: {caps: ["compute", "ui", "libs"]},
    live: {caps: ["compute", "ui", "timers"]},
    app: {caps: ["compute", "ui", "persist", "api", "network", "embed", "libs", "timers"]},
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
                resolve(true);
            },
            () => resolve(false),
        );
    });
};

const buildCtx = (blockId: string, host: HTMLElement, caps: Capability[]): SuperBlockCtx => {
    const ctx: SuperBlockCtx = {blockId};
    if (caps.includes("ui")) {
        ctx.el = host;
    }
    if (caps.includes("persist")) {
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
    }
    if (caps.includes("api")) {
        ctx.api = {
            post: async (path: string, body?: object): Promise<IWebSocketData> => {
                if (!API_ALLOW.includes(path)) {
                    throw new Error(`api: endpoint not allowed (${path})`);
                }
                if (!(await ensureGrant(blockId, "api", "read from the SiYuan kernel"))) {
                    throw new Error("api: denied by user");
                }
                return fetchSyncPost(path, body || {});
            },
        };
    }
    if (caps.includes("network")) {
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
    }
    if (caps.includes("embed")) {
        ctx.embed = (targetBlockId: string) => {
            const editors = getAllEditor();
            const base = editors[0];
            if (!base) {
                const note = document.createElement("div");
                note.textContent = "embed: no editor available";
                host.appendChild(note);
                return;
            }
            const wrap = document.createElement("div");
            wrap.className = "sb-embed";
            host.appendChild(wrap);
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
            getDisposables(host).editors.push(nested);
        };
    }
    if (caps.includes("timers")) {
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
    }
    if (caps.includes("libs")) {
        ctx.require = (name: string): Promise<unknown> => {
            const lib = LIB_ALLOW[name];
            if (!lib) {
                return Promise.reject(new Error(`require: library not allowed (${name})`));
            }
            return addScript(lib.url, `sb-lib-${name}`)
                .then(() => (window as unknown as Record<string, unknown>)[lib.global]);
        };
    }
    return ctx;
};

// Runs one super-block: builds the gated ctx, compiles the code once, executes it.
// Errors are contained — a throwing block shows an inline message, never breaks the doc.
export const runSuperBlock = (host: HTMLElement, blockId: string, kind: string, code: string) => {
    const preset = PRESETS[kind] || PRESETS.calc;
    // Destroy any nested editors from a previous mount before clearing the host.
    disposeSuperBlock(host);
    host.innerHTML = "";
    // Global kill-switch (policy.ts): no super-block code runs at all.
    if (isKilled()) {
        host.textContent = `super-block (${kind}) — disabled by settings`;
        return;
    }
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
    } catch (e) {
        host.textContent = `super-block error: ${(e as Error).message}`;
    }
};
