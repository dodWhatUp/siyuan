// Block decorators — augment EXISTING native blocks in place (any type) with custom
// UI/behavior, WITHOUT converting them to super-blocks. A decorator declares a
// `match(blockEl)` predicate and a `decorate(blockEl)` that injects UI / wires
// behavior / reads-writes the block. A single shared MutationObserver applies
// decorators to current + future blocks; `decorate` may return a cleanup run on
// block removal. This is the "read other block types, add capability + new UI" gap.

export interface BlockDecorator {
    id: string;
    match: (el: HTMLElement) => boolean;
    decorate: (el: HTMLElement) => void | (() => void);
}

const decorators = new Map<string, BlockDecorator>();
const cleanups = new WeakMap<HTMLElement, Map<string, () => void>>();
let observer: MutationObserver | null = null;

const flagOf = (id: string) => "data-sbdec-" + id;

const applyTo = (el: HTMLElement) => {
    decorators.forEach((d) => {
        if (el.hasAttribute(flagOf(d.id))) { return; }
        let ok = false;
        try { ok = d.match(el); } catch { ok = false; }
        if (!ok) { return; }
        el.setAttribute(flagOf(d.id), "1");
        try {
            const cleanup = d.decorate(el);
            if (typeof cleanup === "function") {
                let m = cleanups.get(el);
                if (!m) { m = new Map(); cleanups.set(el, m); }
                m.set(d.id, cleanup);
            }
        } catch (e) { console.warn("[superblock] decorator error", d.id, e); }
    });
};

const runCleanups = (el: HTMLElement) => {
    const m = cleanups.get(el);
    if (m) { m.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); cleanups.delete(el); }
};

const scan = (root: ParentNode) => root.querySelectorAll<HTMLElement>("[data-node-id]").forEach(applyTo);

const ensureObserver = () => {
    if (observer) { return; }
    observer = new MutationObserver((muts) => {
        muts.forEach((m) => {
            m.addedNodes.forEach((n) => {
                if (!(n instanceof HTMLElement)) { return; }
                if (n.hasAttribute("data-node-id")) { applyTo(n); }
                scan(n);
            });
            m.removedNodes.forEach((n) => {
                if (!(n instanceof HTMLElement)) { return; }
                if (n.hasAttribute("data-node-id")) { runCleanups(n); }
                n.querySelectorAll<HTMLElement>("[data-node-id]").forEach(runCleanups);
            });
        });
    });
    observer.observe(document.body, {childList: true, subtree: true});
};

// Register a decorator; applies to existing blocks immediately + future ones via the
// observer. Returns an unregister() that removes it and runs its cleanups.
export const registerBlockDecorator = (def: BlockDecorator): (() => void) => {
    decorators.set(def.id, def);
    ensureObserver();
    scan(document);
    return () => {
        decorators.delete(def.id);
        document.querySelectorAll<HTMLElement>("[" + flagOf(def.id) + "]").forEach((el) => {
            el.removeAttribute(flagOf(def.id));
            const m = cleanups.get(el);
            if (m && m.has(def.id)) { try { m.get(def.id)!(); } catch { /* ignore */ } m.delete(def.id); }
        });
    };
};

export const listBlockDecorators = (): string[] => Array.from(decorators.keys());
