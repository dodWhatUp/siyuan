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
import {effectiveCaps, isKilled} from "./policy";

export type Capability = "compute" | "ui" | "persist" | "api" | "network";

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
}

// A preset is a named capability profile — the user-facing "block type".
export interface SuperBlockPreset {
    caps: Capability[];
}

export const PRESETS: Record<string, SuperBlockPreset> = {
    calc: {caps: ["compute", "ui"]},
    hello: {caps: ["compute", "ui"]},
    data: {caps: ["compute", "ui", "persist"]},
    app: {caps: ["compute", "ui", "persist", "api", "network"]},
};

const SB_STATE = "custom-sb-state";

// Read-only kernel endpoints a super-block may call via ctx.api.post. Anything
// that mutates the vault is intentionally excluded — block code should not be
// able to silently rewrite other blocks.
const API_ALLOW = [
    "/api/query/sql",
    "/api/block/getBlockInfo",
    "/api/block/getBlockKramdown",
    "/api/attr/getBlockAttrs",
];

// Session-scoped capability grants, keyed by blockId. Cleared on reload (so a
// synced/imported block re-prompts). Persisting grants to an IAL is a later step.
const grants = new Map<string, Set<Capability>>();

// First-use confirm. Resolves true once the user allows `cap` for `blockId`
// (remembered for the session); false if they cancel.
const ensureGrant = (blockId: string, cap: Capability): Promise<boolean> => {
    const have = grants.get(blockId);
    if (have && have.has(cap)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        confirmDialog(
            `Super-block — allow "${cap}"?`,
            `Block …${blockId.slice(-6)} is requesting the <b>${cap}</b> capability ` +
            `(${cap === "api" ? "read from the SiYuan kernel" : "make network requests"}). ` +
            `Allow for this session?`,
            () => {
                let set = grants.get(blockId);
                if (!set) {
                    set = new Set();
                    grants.set(blockId, set);
                }
                set.add(cap);
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
                if (!(await ensureGrant(blockId, "api"))) {
                    throw new Error("api: denied by user");
                }
                return fetchSyncPost(path, body || {});
            },
        };
    }
    if (caps.includes("network")) {
        ctx.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            if (!(await ensureGrant(blockId, "network"))) {
                throw new Error("network: denied by user");
            }
            return fetch(input, init);
        };
    }
    return ctx;
};

// Runs one super-block: builds the gated ctx, compiles the code once, executes it.
// Errors are contained — a throwing block shows an inline message, never breaks the doc.
export const runSuperBlock = (host: HTMLElement, blockId: string, kind: string, code: string) => {
    const preset = PRESETS[kind] || PRESETS.calc;
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
        // eslint-disable-next-line no-new-func
        const fn = new Function("ctx", code);
        fn(buildCtx(blockId, host, caps));
    } catch (e) {
        host.textContent = `super-block error: ${(e as Error).message}`;
    }
};
