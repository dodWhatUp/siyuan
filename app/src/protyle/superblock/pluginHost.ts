// Plugin host — backs the "surfaces" that need real layout integration: custom
// TABS and COMMAND-palette entries. Rather than reimplement SiYuan's tab/command
// machinery (a workaround), we lazily create ONE genuine Plugin instance from the
// live App and delegate to its real addTab / addCommand. Because it's built on
// first use (well after the layout exists), it sidesteps the app-init ordering that
// afterLoadPlugin assumes for normal plugins — so tabs/commands behave exactly like
// any plugin's, with no special-casing.
//
// This module imports the Plugin class lazily-at-call (never at import time), so it
// can't introduce an import-cycle break in the early-loaded runtime.

import {Plugin} from "../../plugin";
import {getAllEditor} from "../../layout/getAll";
import {openFile} from "../../editor/util";

let sbPlugin: Plugin | null = null;

// Create (once) the real super-block host plugin from the active editor's App.
// Returns null before any editor exists (e.g. very early boot) — callers degrade.
const getSbPlugin = (): Plugin | null => {
    if (sbPlugin) {
        return sbPlugin;
    }
    const app = getAllEditor()[0]?.protyle?.app;
    if (!app) {
        return null;
    }
    sbPlugin = new Plugin({app, name: "__superblock-host__", displayName: "Super Block", i18n: {}});
    const w = window.siyuan as unknown as {plugins?: Plugin[]};
    if (!w.plugins) {
        w.plugins = [];
    }
    w.plugins.push(sbPlugin);
    return sbPlugin;
};

let tabSeq = 0;

// Open a custom tab whose body is rendered by `render(el)`. Registers a model on
// the host plugin (addTab) then opens it (openFile custom path resolves the model
// via app.plugins[].models[id]). Returns null if no App is available yet.
export const surfaceOpenTab = (o: {
    title: string;
    icon?: string;
    render: (el: HTMLElement) => void;
    data?: unknown;
}): boolean => {
    const p = getSbPlugin();
    if (!p) {
        return false;
    }
    const type = "sbtab-" + (tabSeq++);
    p.addTab({
        type,
        init() {
            try {
                o.render((this as unknown as {element: HTMLElement}).element);
            } catch (e) {
                console.warn("[superblock] tab render error", e);
            }
        },
    });
    openFile({
        app: (p as unknown as {app: import("../../index").App}).app,
        custom: {icon: o.icon || "iconLayout", title: o.title, id: p.name + type, data: o.data || {}},
    });
    return true;
};

// Add a command-palette entry (searchable, optionally hotkeyed). Returns an
// unregister fn (or a no-op if no App yet).
export const surfaceCommand = (o: {
    id: string;
    label: string;
    hotkey?: string;
    callback: () => void;
}): (() => void) => {
    const p = getSbPlugin();
    if (!p) {
        return () => undefined;
    }
    p.addCommand({langKey: o.id, langText: o.label, hotkey: o.hotkey || "", callback: o.callback});
    return () => {
        const i = p.commands.findIndex((c) => c.langKey === o.id);
        if (i >= 0) {
            p.commands.splice(i, 1);
        }
    };
};
