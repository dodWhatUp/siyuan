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
    registerFeature, getFeature, listFeatures,
} from "./runtime";
import {applyFilter, applySort, applyGroup, applyManualOrder, applyView} from "./viewEngine";
import {registerBuiltinFeatures} from "./builtinFeatures";

export const SUPERBLOCK_API_VERSION = "0.2.0";

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
        registerFeature,
        // lifecycle
        on: onSuperBlockEvent,
        // introspection
        listPresets,
        getPreset,
        listFeatures,
        getFeature,
        // programmatic control
        insertSuperBlock,
        updateSuperBlock,
        getState: getSuperBlockState,
        setState: setSuperBlockState,
        rerender: rerenderSuperBlock,
        // shared view engine (notes/15) — filter/sort/group/order for data features
        view: {applyFilter, applySort, applyGroup, applyManualOrder, applyView},
    };
    // Register the core built-in features (query, …) so they're available by default.
    registerBuiltinFeatures();
};
