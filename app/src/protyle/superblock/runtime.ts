// Super-block runtime — compiles and runs a block's user code with a
// capability-gated context (see notes/06-superblock-implementation-plan.md).
//
// Step 4b scope: compute + ui + persist + api + network. Gating by omission —
// only the capabilities a preset enables are attached to `ctx`, so a smaller
// profile is strictly cheaper and exposes less surface. `api`/`network` are also
// off by default: each is granted only after a first-use confirm dialog (per
// block, per capability, for the current session). Later steps add libs / timers
// WITHOUT changing this contract.

import {fetchPost, fetchSyncPost} from "../../util/fetch";
import {confirmDialog} from "../../dialog/confirmDialog";
import {effectiveCaps, isKilled, hasGrant, addGrant} from "./policy";
import {getAllEditor} from "../../layout/getAll";
import {Constants} from "../../constants";

export type Capability = "compute" | "ui" | "persist" | "api" | "network" | "embed";

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
    // browser fetch after a first-use confirm. (Domain allowlist comes later.)
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    // present only when the "embed" capability is enabled. Mounts a REAL nested
    // Protyle editor for the target block into ctx.el — fully editable, unlike a
    // stock read-only embed. The nested editor is destroyed on re-render.
    embed?: (targetBlockId: string) => void;
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
    app: {caps: ["compute", "ui", "persist", "api", "network", "embed"]},
};

// Nested Protyle editors mounted by ctx.embed, tracked per host so they can be
// destroyed before the host is cleared on re-render (avoids leaked WS listeners).
const nestedEditors = new WeakMap<HTMLElement, Array<{destroy: () => void}>>();

const SB_STATE = "custom-sb-state";

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
                    blockEl.setAttribute(SB_STATE, json);
                    fetchPost("/api/attr/setBlockAttrs", {id: blockId, attrs: {[SB_STATE]: json}});
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
            let list = nestedEditors.get(host);
            if (!list) {
                list = [];
                nestedEditors.set(host, list);
            }
            list.push(nested);
        };
    }
    return ctx;
};

// Runs one super-block: builds the gated ctx, compiles the code once, executes it.
// Errors are contained — a throwing block shows an inline message, never breaks the doc.
export const runSuperBlock = (host: HTMLElement, blockId: string, kind: string, code: string) => {
    const preset = PRESETS[kind] || PRESETS.calc;
    // Destroy any nested editors from a previous mount before clearing the host,
    // so their WebSocket/listeners are released (not just orphaned in the DOM).
    const prevNested = nestedEditors.get(host);
    if (prevNested) {
        prevNested.forEach((p) => {
            try {
                p.destroy();
            } catch (e) {
                // ignore teardown errors
            }
        });
        nestedEditors.delete(host);
    }
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
