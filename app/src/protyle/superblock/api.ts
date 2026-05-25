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
    registerProperty, getProperty, listProperties,
    listCapabilities,
    allowApiEndpoint, allowWriteEndpoint, allowLibrary,
} from "./runtime";
import {applyFilter, applySort, applyGroup, applyManualOrder, applyView} from "./viewEngine";
import {registerBuiltinFeatures} from "./builtinFeatures";
import {registerBuiltinProperties} from "./builtinProperties";
import {parseRRule, expandOccurrences, upcomingFires, nextFire, collectDueFires} from "./reminderEngine";
import {ReminderScheduler} from "./reminderScheduler";
import {buildICS, icsFromRows, minutesToTrigger} from "./icsExport";
import {parseNlDate, parseQuickAdd, extractTags, extractPriority} from "./nlDate";
import {registerBlockDecorator, listBlockDecorators} from "./blockDecorators";
import {getExportContent, listExports} from "./exportRegistry";
import {adb} from "./adb";

export const SUPERBLOCK_API_VERSION = "0.7.1";

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
        registerProperty,
        // allowlist contributions — a plugin may extend what blocks can reach
        // (still behind the same per-capability user confirm + kill-switch).
        allowApiEndpoint,
        allowWriteEndpoint,
        allowLibrary,
        // lifecycle
        on: onSuperBlockEvent,
        // introspection
        listPresets,
        getPreset,
        listFeatures,
        getFeature,
        listProperties,
        getProperty,
        listCapabilities,
        // block decorators — augment existing native blocks in place
        registerBlockDecorator,
        listBlockDecorators,
        // export registry — read a block's declared static export content (ctx.onExport)
        getExportContent,
        listExports,
        // programmatic control
        insertSuperBlock,
        updateSuperBlock,
        getState: getSuperBlockState,
        setState: setSuperBlockState,
        rerender: rerenderSuperBlock,
        // shared view engine (notes/15) — filter/sort/group/order for data features
        view: {applyFilter, applySort, applyGroup, applyManualOrder, applyView},
        // reminder engine (notes/16) — repeat expansion + fire-time computation
        reminder: {parseRRule, expandOccurrences, upcomingFires, nextFire, collectDueFires, ReminderScheduler},
        // .ics export (notes/16) — task → calendar sync-out
        ics: {buildICS, icsFromRows, minutesToTrigger},
        // natural-language quick-add (ported from task plugin)
        nl: {parseNlDate, parseQuickAdd, extractTags, extractPriority},
        // advanced-database schema FOUNDATION (notes/20) — read/write/validate/resolve
        // a behavior layer over a native database; no features, just the contract.
        adb,
    };
    // Register the core built-in features (query, …) so they're available by default.
    registerBuiltinFeatures();
    // Register the core built-in property components (reminder, …).
    registerBuiltinProperties();
};
