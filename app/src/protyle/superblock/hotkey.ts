// Hotkey parsing/matching for the "command" capability. Pure + unit-tested; the
// runtime's command cap uses matchHotkey against keydown events.
//
// Spec syntax (case-insensitive, "+"-separated): modifiers then key, e.g.
//   "ctrl+k" · "ctrl+shift+p" · "alt+1" · "mod+s" (mod = Ctrl OR Cmd) · "shift+a".

export interface Hotkey { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; mod: boolean; }

export const parseHotkey = (spec: string): Hotkey => {
    const hk: Hotkey = {key: "", ctrl: false, shift: false, alt: false, meta: false, mod: false};
    String(spec || "").toLowerCase().split("+").map((s) => s.trim()).filter(Boolean).forEach((p) => {
        if (p === "ctrl" || p === "control") { hk.ctrl = true; }
        else if (p === "shift") { hk.shift = true; }
        else if (p === "alt" || p === "option") { hk.alt = true; }
        else if (p === "meta" || p === "cmd" || p === "command" || p === "win") { hk.meta = true; }
        else if (p === "mod") { hk.mod = true; }   // Ctrl on Win/Linux, Cmd on macOS
        else { hk.key = p; }
    });
    return hk;
};

export interface KeyEventLike { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; }

// The set of names an event can match. Includes the PHYSICAL key (event.code) so
// that e.g. macOS Option+1 — where event.key is "¡" not "1" — still matches "alt+1".
const eventKeys = (ev: KeyEventLike): Set<string> => {
    const out = new Set<string>();
    if (ev.key) { out.add(ev.key.toLowerCase()); }
    if (ev.code) {
        const c = ev.code.toLowerCase();        // "digit1", "keyk", "f1"
        out.add(c);
        out.add(c.replace(/^key/, "").replace(/^digit/, ""));   // "keyk"→"k", "digit1"→"1"
    }
    return out;
};

export const matchHotkey = (spec: string, ev: KeyEventLike): boolean => {
    const hk = parseHotkey(spec);
    if (!hk.key || !eventKeys(ev).has(hk.key)) { return false; }
    if (hk.shift !== ev.shiftKey) { return false; }
    if (hk.alt !== ev.altKey) { return false; }
    if (hk.mod) {
        return ev.ctrlKey || ev.metaKey;     // either platform modifier
    }
    return hk.ctrl === ev.ctrlKey && hk.meta === ev.metaKey;
};
