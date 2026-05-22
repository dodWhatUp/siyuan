// Super-block runtime — compiles and runs a block's user code with a
// capability-gated context (see notes/06-superblock-implementation-plan.md).
//
// Step 4a scope: compute + ui + persist. Gating by omission — only the
// capabilities a preset enables are attached to `ctx`, so a smaller profile is
// strictly cheaper and exposes less surface. Later steps add api / network /
// libs / timers WITHOUT changing this contract.

import {fetchPost} from "../../util/fetch";

export type Capability = "compute" | "ui" | "persist";

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
}

// A preset is a named capability profile — the user-facing "block type".
export interface SuperBlockPreset {
    caps: Capability[];
}

export const PRESETS: Record<string, SuperBlockPreset> = {
    calc: {caps: ["compute", "ui"]},
    hello: {caps: ["compute", "ui"]},
    data: {caps: ["compute", "ui", "persist"]},
};

const SB_STATE = "custom-sb-state";

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
    return ctx;
};

// Runs one super-block: builds the gated ctx, compiles the code once, executes it.
// Errors are contained — a throwing block shows an inline message, never breaks the doc.
export const runSuperBlock = (host: HTMLElement, blockId: string, kind: string, code: string) => {
    const preset = PRESETS[kind] || PRESETS.calc;
    host.innerHTML = "";
    if (!code) {
        host.textContent = `super-block (${kind}) — no code`;
        return;
    }
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function("ctx", code);
        fn(buildCtx(blockId, host, preset.caps));
    } catch (e) {
        host.textContent = `super-block error: ${(e as Error).message}`;
    }
};
