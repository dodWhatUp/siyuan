// UI surfaces — runtime helpers for the "surfaces" capability. Let super-block
// code add app-level UI OUTSIDE its own block: a top-bar icon, a status-bar item,
// or a slash (/) command. These three register at RUNTIME (DOM append / array
// push), so they work after the app has booted — unlike docks and custom tabs,
// which SiYuan registers at layout-init time and can't be added cleanly afterward.
//
// Each helper returns an unregister() that fully removes what it added; the runtime
// wires those into the block's per-host unmount cleanup so nothing leaks when the
// block re-renders or is deleted.

// Minimal shape of the pseudo-plugin entry in window.siyuan.plugins that the hint
// menu reads slash commands from (see protyle/hint/extend.ts).
export interface SlashHost {
    name: string;
    protyleSlash: Array<{
        filter: string[];
        html: string;
        id: string;
        callback: (protyle: unknown, nodeElement: HTMLElement) => void;
    }>;
}

// Accept either an "icon-foo" id (SiYuan symbol sprite) or a raw <svg> string,
// matching Plugin.addTopBar's contract.
const iconHTML = (icon: string): string => {
    const t = icon.trim();
    return t.startsWith("<svg") ? t : `<svg><use xlink:href="#${t}"></use></svg>`;
};

// Top-bar icon (the toolbar at the top-right, next to the plugin icons). Mirrors
// Plugin.addTopBar: a .toolbar__item appended before #barPlugins (right) or #drag
// (left). Falls back to #toolbar / body when those anchors are absent (e.g. tests).
export const addTopBar = (opts: {
    icon: string;
    title: string;
    position?: "left" | "right";
    onclick: (e: MouseEvent) => void;
}): (() => void) => {
    const el = document.createElement("div");
    el.className = "toolbar__item ariaLabel";
    el.setAttribute("aria-label", opts.title);
    el.setAttribute("data-location", opts.position || "right");
    el.setAttribute("data-sb-surface", "topbar");
    el.innerHTML = iconHTML(opts.icon);
    el.addEventListener("click", opts.onclick);
    const anchor = document.querySelector("#" + (opts.position === "left" ? "drag" : "barPlugins"));
    if (anchor) {
        anchor.before(el);
    } else {
        (document.querySelector("#toolbar") || document.body).appendChild(el);
    }
    return () => el.remove();
};

// Status-bar item (the thin bar at the bottom). Mirrors Plugin.addStatusBar:
// append the element to #status (end = right, start = left).
export const addStatusBar = (opts: {
    html?: string;
    element?: HTMLElement;
    position?: "left" | "right";
    onclick?: (e: MouseEvent) => void;
}): (() => void) => {
    const el = opts.element || document.createElement("div");
    el.classList.add("status__item");
    el.setAttribute("data-sb-surface", "statusbar");
    if (opts.html != null) {
        el.innerHTML = opts.html;
    }
    if (opts.onclick) {
        el.addEventListener("click", opts.onclick);
    }
    const status = document.getElementById("status");
    if (status) {
        if ((opts.position || "right") === "right") {
            status.insertAdjacentElement("beforeend", el);
        } else {
            status.insertAdjacentElement("afterbegin", el);
        }
    } else {
        document.body.appendChild(el);
    }
    return () => el.remove();
};

// Block context-menu item — augment the right-click (gutter) menu of EXISTING
// native blocks. SiYuan emits a "click-blockicon" event to every plugin's eventBus
// with detail {menu, protyle, blockElements}; a handler calls menu.addItem(...) to
// contribute an item. This builds that handler from a simple option object: an
// optional match(blockEl) gates which blocks get the item, and click(blockEl, detail)
// fires when chosen. Returned handler is pure (no fork deps) so it is unit-testable;
// the runtime subscribes/unsubscribes it on the shared sb eventBus.
export interface BlockMenuItem {
    id: string;
    label: string;
    icon?: string;                                   // "iconName" (sprite id) — optional
    match?: (blockEl: HTMLElement) => boolean;       // default: every block
    click: (blockEl: HTMLElement, detail: BlockIconDetail) => void;
}
export interface BlockIconDetail {
    blockElements?: HTMLElement[];
    menu?: {addItem: (o: {id?: string; icon?: string; label: string; click: () => void}) => void};
    protyle?: unknown;
}
export const makeBlockMenuHandler = (item: BlockMenuItem) => (e: {detail?: BlockIconDetail}): void => {
    const detail = e && e.detail;
    if (!detail || !detail.menu || typeof detail.menu.addItem !== "function") { return; }
    const blocks = detail.blockElements || [];
    const target = item.match ? blocks.find((b) => { try { return item.match!(b); } catch { return false; } }) : blocks[0];
    if (!target) { return; }
    detail.menu.addItem({
        id: "sb-blockmenu-" + item.id,
        icon: item.icon,
        label: item.label,
        click: () => { try { item.click(target, detail); } catch (err) { console.warn("[superblock] blockMenu click error", item.id, err); } },
    });
};

// Slash (/) command — pushes an entry into the pseudo-plugin's protyleSlash array,
// which the hint menu aggregates live (protyle/hint/extend.ts). `run` fires when
// the user picks it from the / menu; it receives the protyle + the node element.
export const addSlashCommand = (host: SlashHost, cmd: {
    id: string;
    name: string;
    html?: string;
    run: (protyle: unknown, nodeElement: HTMLElement) => void;
}): (() => void) => {
    const entry = {
        filter: [cmd.name, cmd.id],
        html: cmd.html ||
            `<div class="b3-list-item__first"><span class="b3-list-item__text">${cmd.name}</span></div>`,
        id: cmd.id,
        callback: cmd.run,
    };
    host.protyleSlash.push(entry);
    return () => {
        const i = host.protyleSlash.indexOf(entry);
        if (i >= 0) {
            host.protyleSlash.splice(i, 1);
        }
    };
};
