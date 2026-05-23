// Super-block public API (notes/09 SPI steps 5–7). Assembles the runtime's
// extension points into one versioned object exposed at `window.siyuan.superblock`,
// so a SiYuan plugin can discover it (feature-detect via `.version`) and:
//   - register block types (presets) and capabilities,
//   - subscribe to lifecycle events,
//   - create / update / inspect super-blocks programmatically.
// Everything still runs behind the user's per-capability confirm + kill-switch.

import {
    registerPreset, registerCapability, getPreset, listPresets, onSuperBlockEvent,
    insertSuperBlock, updateSuperBlock, getSuperBlockState, setSuperBlockState, rerenderSuperBlock,
} from "./runtime";

export const SUPERBLOCK_API_VERSION = "0.1.0";

// Idempotent: registers window.siyuan.superblock once, at app init (before
// plugins load), so plugins can use it in their onload.
export const registerSuperBlockAPI = () => {
    const w = window.siyuan as unknown as Record<string, unknown>;
    if (w.superblock) {
        return;
    }
    w.superblock = {
        version: SUPERBLOCK_API_VERSION,
        // extension registry
        registerPreset,
        registerCapability,
        // lifecycle
        on: onSuperBlockEvent,
        // introspection
        listPresets,
        getPreset,
        // programmatic control
        insertSuperBlock,
        updateSuperBlock,
        getState: getSuperBlockState,
        setState: setSuperBlockState,
        rerender: rerenderSuperBlock,
    };
};
