// Super-block runtime — compiles and runs a block's user code with a
// capability-gated context (see notes/06-superblock-implementation-plan.md).
//
// Step 2 scope: compute + ui only. Gating by omission — only the capabilities a
// preset enables are attached to `ctx`, so a smaller profile is strictly cheaper
// and exposes less surface. Later steps add api / network / persist / libs /
// timers WITHOUT changing this contract.

export type Capability = "compute" | "ui";

export interface SuperBlockCtx {
    blockId: string;
    el?: HTMLElement; // present only when the "ui" capability is enabled
}

// A preset is a named capability profile — the user-facing "block type".
export interface SuperBlockPreset {
    caps: Capability[];
}

export const PRESETS: Record<string, SuperBlockPreset> = {
    calc: {caps: ["compute", "ui"]},
    hello: {caps: ["compute", "ui"]},
};

const buildCtx = (blockId: string, host: HTMLElement, caps: Capability[]): SuperBlockCtx => {
    const ctx: SuperBlockCtx = {blockId};
    if (caps.includes("ui")) {
        ctx.el = host;
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
