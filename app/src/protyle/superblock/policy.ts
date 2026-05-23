// Super-block safety policy (see notes/06-superblock-implementation-plan.md, P8).
//
// A small, frontend-only policy the runtime consults before running a block or
// granting a capability. Stored in localStorage (per-browser, read synchronously,
// no kernel change). Two controls:
//   - kill: a global kill-switch — no super-block code runs at all.
//   - disabled: capabilities switched off globally; dropped from `ctx` even when
//     a preset enables them. (compute/ui can be disabled too, but that mostly
//     just neuters blocks; the useful targets are api / network / persist.)
//
// This is the global, owner-level control. It sits ABOVE the per-block, per-cap
// first-use confirm in runtime.ts — a globally-disabled cap never even reaches
// the confirm step.

import type {Capability} from "./runtime";

const KEY = "sb-policy";

export interface SuperBlockPolicy {
    kill: boolean;
    disabled: Capability[];
}

const DEFAULT_POLICY: SuperBlockPolicy = {kill: false, disabled: []};

export const getPolicy = (): SuperBlockPolicy => {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return {...DEFAULT_POLICY};
        }
        const parsed = JSON.parse(raw);
        return {
            kill: !!parsed.kill,
            disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
        };
    } catch {
        return {...DEFAULT_POLICY};
    }
};

export const setPolicy = (policy: SuperBlockPolicy) => {
    localStorage.setItem(KEY, JSON.stringify(policy));
};

export const isKilled = (): boolean => getPolicy().kill;

export const isCapDisabled = (cap: Capability): boolean => getPolicy().disabled.includes(cap);

// Filter a preset's caps down to what policy currently allows.
export const effectiveCaps = (caps: Capability[]): Capability[] => {
    const disabled = getPolicy().disabled;
    return caps.filter((c) => !disabled.includes(c));
};
