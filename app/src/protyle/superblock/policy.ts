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

// --- Persisted permission grants -------------------------------------------
// Remembered api/network grants, so the first-use confirm is truly one-time.
// Stored in localStorage (per-DEVICE, not synced) keyed by blockId → labels.
// Network grants are per-domain ("network:<host>"), which doubles as the domain
// allowlist. Device-local on purpose: a synced/imported block re-prompts on
// another device rather than inheriting trust.
const GRANTS_KEY = "sb-grants";
type GrantStore = Record<string, string[]>;

const getGrantStore = (): GrantStore => {
    try {
        const raw = localStorage.getItem(GRANTS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
};

export const hasGrant = (blockId: string, label: string): boolean => {
    const list = getGrantStore()[blockId];
    return !!list && list.includes(label);
};

export const addGrant = (blockId: string, label: string) => {
    const store = getGrantStore();
    const list = store[blockId] || [];
    if (!list.includes(label)) {
        list.push(label);
    }
    store[blockId] = list;
    localStorage.setItem(GRANTS_KEY, JSON.stringify(store));
};

export const clearGrants = () => localStorage.removeItem(GRANTS_KEY);

// A compact string that changes whenever policy that affects rendering changes
// (kill-switch, disabled caps). Used by the runtime's idempotent-render guard so
// a policy change forces a re-run while an otherwise-unchanged block does not.
export const policySignature = (): string => JSON.stringify(getPolicy());
