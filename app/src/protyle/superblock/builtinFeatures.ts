// Built-in super-block features (notes/14 L2, notes/15 catalog). A small core set
// registered at init so they're usable out of the box and survive reload; plugins
// add more via window.siyuan.superblock.registerFeature. Each is config-driven.

import {registerFeature, SuperBlockCtx, getProperty} from "./runtime";
import {applyView, ViewRecord, ViewConfig} from "./viewEngine";
import {ReminderScheduler} from "./reminderScheduler";
import {icsFromRows} from "./icsExport";
import {isFrozen} from "./featureFlags";

// Trigger a client-side text download (browser only; no-ops if unavailable).
const downloadText = (filename: string, text: string, mime = "text/calendar") => {
    try {
        const blob = new Blob([text], {type: mime});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { console.warn("[superblock] .ics download failed", e); }
};

// Start a reminder scheduler for a reminder-configured database; auto-stops on
// unmount (needs the "timers" cap for ctx.onUnmount). Notifications fire as each
// reminder's time arrives. Reuses the gated ctx.av for reads.
const startReminderScheduler = (ctx: SuperBlockCtx, avId: string, dateKey: string, reminderKey: string) => {
    if (!ctx.av || !ctx.onUnmount) { return; }
    const sched = new ReminderScheduler({
        getSources: () => [{avID: avId, dateCol: dateKey, reminderCol: reminderKey}],
        read: (id) => ctx.av!.read(id) as Promise<{rows: unknown[]}>,
    });
    sched.ensurePermission();
    sched.start();
    ctx.onUnmount(() => sched.stop());
};

// Full-text search blocks → ViewRecords (pure, testable). Strips <mark> highlights.
export interface FtBlock { id?: string; content?: string; hPath?: string; name?: string; }
const stripMark = (s: string): string => s.replace(/<\/?mark>/g, "");
export const mapFullTextBlocks = (blocks: FtBlock[]): ViewRecord[] =>
    (blocks || []).map((b, i) => ({
        id: String(b.id || i),
        values: {content: stripMark(b.content || ""), path: b.hPath || "", name: b.name || ""},
    }));

// Default block types for full-text search when the block doesn't specify its own.
const FT_DEFAULT_TYPES = {
    document: true, heading: true, list: true, listItem: true, codeBlock: true, htmlBlock: true,
    mathBlock: true, table: true, blockquote: true, superBlock: true, paragraph: true,
};

// A SiYuan block id looks like 20260523083557-4j0mave. If a result row carries one
// (via an `id` value, or its record id), the row becomes openable.
const SB_ID_RE = /^\d{14}-[a-z0-9]{7}$/;
const blockIdOf = (rec: ViewRecord): string | null => {
    const v = rec.values.id;
    if (typeof v === "string" && SB_ID_RE.test(v)) { return v; }
    return SB_ID_RE.test(rec.id) ? rec.id : null;
};

// A small "open in new window" affordance for a result.
const newWindowBtn = (id: string, open: (id: string, nw?: boolean) => void): HTMLElement => {
    const b = document.createElement("span");
    b.textContent = "⧉";
    b.title = "Open in new window";
    b.style.cssText = "cursor:pointer;margin-right:4px;opacity:.6";
    b.onclick = (e) => { e.stopPropagation(); open(id, true); };
    return b;
};

// Render a flat record list as a table or bulleted list. When `open` is given,
// rows that carry a block id become clickable (open/edit it) with a new-window button.
const renderRecordList = (container: HTMLElement, list: ViewRecord[], mode: string, open?: (id: string, nw?: boolean) => void) => {
    if (!list.length) { return; }
    const cols = Object.keys(list[0].values);
    if (mode === "list") {
        const ul = document.createElement("ul");
        list.forEach((rec) => {
            const li = document.createElement("li");
            const id = open ? blockIdOf(rec) : null;
            if (id) {
                li.appendChild(newWindowBtn(id, open!));
                li.appendChild(document.createTextNode(String(rec.values[cols[0]] ?? "")));
                li.style.cursor = "pointer";
                li.title = "Click to open";
                li.onclick = () => open!(id, false);
            } else {
                li.textContent = String(rec.values[cols[0]] ?? "");
            }
            ul.appendChild(li);
        });
        container.appendChild(ul);
        return;
    }
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;font-size:12px";
    const head = document.createElement("tr");
    cols.forEach((c) => {
        const th = document.createElement("th");
        th.textContent = c;
        th.style.cssText = "border:1px solid var(--b3-border-color);padding:2px 6px;text-align:left";
        head.appendChild(th);
    });
    table.appendChild(head);
    list.forEach((rec) => {
        const tr = document.createElement("tr");
        const id = open ? blockIdOf(rec) : null;
        cols.forEach((c, ci) => {
            const td = document.createElement("td");
            td.style.cssText = "border:1px solid var(--b3-border-color);padding:2px 6px";
            if (ci === 0 && id) {
                td.appendChild(newWindowBtn(id, open!));
                td.appendChild(document.createTextNode(String(rec.values[c] ?? "")));
            } else {
                td.textContent = String(rec.values[c] ?? "");
            }
            tr.appendChild(td);
        });
        if (id) {
            tr.style.cursor = "pointer";
            tr.title = "Click to open";
            tr.onclick = () => open!(id, false);
        }
        table.appendChild(tr);
    });
    container.appendChild(table);
};

// A saved view = a named {mode, groupBy} over the same query (Notion-style).
interface QView { name: string; mode: string; groupBy?: string; }
const parseQueryViews = (cfg: Record<string, unknown>): QView[] => {
    const raw = cfg.views;
    if (Array.isArray(raw) && raw.length) {
        return (raw as Array<Record<string, unknown>>).map((v, i) => ({
            name: String(v.name || `View ${i + 1}`),
            mode: String(v.mode || cfg.mode || "table"),
            groupBy: v.groupBy ? String(v.groupBy) : (cfg.groupBy ? String(cfg.groupBy) : undefined),
        }));
    }
    return [{name: "View", mode: String(cfg.mode || "table"), groupBy: cfg.groupBy ? String(cfg.groupBy) : undefined}];
};

// Client-side quick filter: keep records where any value contains the query (ci).
export const quickFilterRecords = (records: ViewRecord[], query: string): ViewRecord[] => {
    const q = (query || "").trim().toLowerCase();
    if (!q) { return records; }
    return records.filter((r) => Object.values(r.values).some((v) => String(v ?? "").toLowerCase().includes(q)));
};

// Paint a processed result (flat list or grouped map) into `container`.
const paintRecords = (container: HTMLElement, processed: ViewRecord[] | Record<string, ViewRecord[]>, mode: string, open?: (id: string, nw?: boolean) => void) => {
    if (Array.isArray(processed)) {
        if (!processed.length) { container.textContent = "no results"; return; }
        renderRecordList(container, processed, mode, open);
        return;
    }
    const keys = Object.keys(processed);
    if (keys.reduce((n, k) => n + processed[k].length, 0) === 0) { container.textContent = "no results"; return; }
    keys.forEach((k) => {
        const det = document.createElement("details");
        det.open = true;
        const sum = document.createElement("summary");
        sum.textContent = `${k || "(empty)"}  (${processed[k].length})`;
        sum.style.cssText = "cursor:pointer;font-weight:bold;font-size:12px;margin:4px 0";
        det.appendChild(sum);
        renderRecordList(det, processed[k], mode, open);
        container.appendChild(det);
    });
};

// Query / Search: a SQL query OR a full-text search (config.source), rendered as
// table|list through the shared view engine. Advanced: multiple saved `views` with
// a switcher (tabs), per-view group-by with collapsible counts, and a live quick
// filter box. Gated api cap.
const queryRun = (ctx: SuperBlockCtx, cfg: Record<string, unknown>) => {
    const el = ctx.el as HTMLElement;
    const source = String(cfg.source || "sql");
    const stmt = String(cfg.query || (source === "fulltext"
        ? ""
        : "SELECT id, content FROM blocks WHERE content != '' ORDER BY updated DESC LIMIT 10"));
    const baseView: ViewConfig = {...((cfg.view as ViewConfig) || {})};
    const views = parseQueryViews(cfg);
    let activeView = 0;
    let quickFilter = "";
    let records: ViewRecord[] = [];

    const fetchRecords = (): Promise<ViewRecord[]> => {
        if (source === "fulltext") {
            return ctx.api!.post!("/api/search/fullTextSearchBlock", {
                query: stmt, method: 0, types: (cfg.types as object) || FT_DEFAULT_TYPES,
                paths: [], groupBy: 0, orderBy: 0, page: 1,
            }).then((r: IWebSocketData) => mapFullTextBlocks(((r.data as {blocks?: FtBlock[]}) || {}).blocks || []));
        }
        return ctx.api!.post!("/api/query/sql", {stmt}).then((r: IWebSocketData) =>
            ((r.data as Array<Record<string, unknown>>) || []).map((row, i) => ({id: String(row.id || i), values: row})));
    };

    // Repaint only the result body (keeps the filter input focused while typing).
    const paintBody = (body: HTMLElement) => {
        const v = views[activeView];
        const vc: ViewConfig = {...baseView};
        if (v.groupBy) { vc.group = v.groupBy; }
        body.innerHTML = "";
        const recs = quickFilterRecords(records, quickFilter);
        // "embed" mode: render each result as a LIVE EDITABLE nested block (Roam/
        // Logseq style), reusing ctx.embed. Edit results in place, not just open them.
        if (v.mode === "embed") {
            if (!ctx.embed) { body.textContent = "embed capability unavailable"; return; }
            if (!recs.length) { body.textContent = "no results"; return; }
            recs.forEach((rec) => {
                const id = blockIdOf(rec);
                const w = document.createElement("div");
                w.style.cssText = "margin:4px 0;border:1px solid var(--b3-border-color);border-radius:4px;padding:2px";
                body.appendChild(w);
                if (id) { ctx.embed!(id, w); } else { w.textContent = String(Object.values(rec.values)[0] ?? "") + "  (no block id — add id to the query)"; }
            });
            return;
        }
        paintRecords(body, applyView(recs, vc), v.mode, ctx.open);
    };

    // Repaint the whole feature: view-switcher tabs (if >1) + quick-filter box + body.
    const paint = () => {
        el.innerHTML = "";
        const bar = document.createElement("div");
        bar.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap";
        if (views.length > 1) {
            views.forEach((v, i) => {
                const btn = document.createElement("button");
                btn.textContent = v.name;
                btn.className = "b3-button " + (i === activeView ? "b3-button--text" : "b3-button--outline");
                btn.onclick = () => { activeView = i; paint(); };
                bar.appendChild(btn);
            });
        }
        const body = document.createElement("div");
        const filter = document.createElement("input");
        filter.className = "b3-text-field";
        filter.placeholder = "filter…";
        filter.value = quickFilter;
        filter.style.cssText = "flex:1;min-width:80px";
        filter.oninput = () => { quickFilter = filter.value; paintBody(body); };
        bar.appendChild(filter);
        el.appendChild(bar);
        el.appendChild(body);
        paintBody(body);
    };

    const refresh = () => {
        el.textContent = "loading…";
        fetchRecords().then((r: ViewRecord[]) => { records = r; paint(); }).catch((e: Error) => { el.textContent = "ERR: " + e.message; });
    };
    refresh();
    // Live re-query on data changes — but NOT while showing editable embeds, where a
    // refetch would tear down + rebuild the nested editors on every keystroke echo.
    ctx.watch?.(() => { if (views[activeView].mode !== "embed") { refresh(); } });
};

// Calendar: a month view over a database (Attribute View) by a date column —
// the view SiYuan lacks. Reads via ctx.av, places rows by date, drag-to-
// reschedule writes the date back. Config-driven (db + date column picked in the
// no-code form). Migrated from the notes/13 prototype.
type AvCellValue = {
    type?: string;
    keyID?: string;
    block?: {content?: string};
    date?: {content: number; isNotEmpty: boolean; [k: string]: unknown};
};
type AvRow = {id: string; cells: Array<{id: string; value: AvCellValue}>};
type CalItem = {
    title: string; ts: number; rowId: string; cellId: string; val: AvCellValue;
    reminderCellId?: string; reminderRaw?: string; reminderVal?: AvCellValue;   // companion reminder cell (P7)
};

// Build calendar items (title + timestamp + cell ref) from a database's rows.
// If reminderKey is given, also capture the row's reminder companion cell.
const buildCalItems = (rows: AvRow[], dateKey: string, reminderKey?: string): CalItem[] => {
    const items: CalItem[] = [];
    rows.forEach((r) => {
        const tc = r.cells.find((c) => c.value && c.value.type === "block");
        const dc = r.cells.find((c) => c.value && c.value.keyID === dateKey);
        const title = (tc && tc.value.block && tc.value.block.content) || "(task)";
        const ts = (dc && dc.value.date && dc.value.date.isNotEmpty) ? dc.value.date.content : null;
        if (ts && dc) {
            const item: CalItem = {title, ts, rowId: r.id, cellId: dc.id, val: dc.value};
            if (reminderKey) {
                const rc = r.cells.find((c) => c.value && c.value.keyID === reminderKey);
                if (rc) {
                    item.reminderCellId = rc.id;
                    item.reminderVal = rc.value;
                    item.reminderRaw = (rc.value as {text?: {content?: string}}).text?.content || "";
                }
            }
            items.push(item);
        }
    });
    return items;
};

// Display text for any AV cell value (used by the table view).
const avCellText = (v: AvCellValue | undefined): string => {
    if (!v) {
        return "";
    }
    const a = v as Record<string, {content?: string; isNotEmpty?: boolean}> & {mSelect?: Array<{content: string}>};
    switch (v.type) {
        case "block": return v.block?.content || "";
        case "date": return v.date && v.date.isNotEmpty ? new Date(v.date.content).toLocaleDateString() : "";
        case "mSelect":
        case "select": return (a.mSelect || []).map((s) => s.content).join(", ");
        case "text": return String(a.text?.content ?? "");
        case "number": return a.number?.isNotEmpty ? String(a.number.content) : "";
        default: return "";
    }
};

// Open a small popover anchored to `anchorEl` to edit the row's reminder via the
// registered "reminder" property component (P7), writing JSON to the companion cell.
const openReminderEditor = (
    anchorEl: HTMLElement, it: CalItem, avId: string, reminderKey: string,
    ctx: SuperBlockCtx, rerender: () => void,
) => {
    const prop = getProperty("reminder");
    if (!prop || !prop.edit) { return; }
    const meta = prop.parse ? prop.parse(it.reminderRaw || "") : {};
    const pop = document.createElement("div");
    pop.style.cssText = "position:fixed;z-index:999;background:var(--b3-menu-background);border:1px solid var(--b3-border-color);border-radius:6px;padding:10px;box-shadow:var(--b3-dialog-shadow);min-width:240px";
    const r = anchorEl.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 260) + "px";
    pop.style.top = (r.bottom + 4) + "px";
    const form = prop.edit(null, meta);
    pop.appendChild(form);
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;margin-top:8px;justify-content:flex-end";
    const cancel = document.createElement("button");
    cancel.className = "b3-button b3-button--cancel";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.className = "b3-button b3-button--text";
    save.textContent = "Save";
    const close = () => pop.remove();
    cancel.onclick = close;
    save.onclick = () => {
        const newMeta = (form as unknown as {getMeta?: () => unknown}).getMeta?.() ?? {};
        const raw = prop.serialize ? prop.serialize(newMeta) : "";
        const data = it.reminderVal
            ? JSON.parse(JSON.stringify(it.reminderVal)) as AvCellValue
            : {} as AvCellValue;
        data.type = "text";
        (data as {text?: {content: string}}).text = {content: raw};
        ctx.av!.setCell({avID: avId, rowID: it.rowId, keyID: reminderKey, cellID: it.reminderCellId || "", data})
            .then(() => { close(); rerender(); })
            .catch((e: Error) => { save.textContent = "ERR: " + e.message; });
    };
    bar.append(cancel, save);
    pop.appendChild(bar);
    document.body.appendChild(pop);
};

// Edit a Location cell (the text cell holds the value directly) via the "location"
// property component; writes the serialized JSON back to the same cell.
const openLocationEditor = (
    anchorEl: HTMLElement, raw: string, avId: string, rowId: string, keyId: string,
    cellId: string, cellVal: AvCellValue | null, ctx: SuperBlockCtx, rerender: () => void,
) => {
    const prop = getProperty("location");
    if (!prop || !prop.edit) { return; }
    const meta = prop.parse ? prop.parse(raw) : null;
    const pop = document.createElement("div");
    pop.style.cssText = "position:fixed;z-index:999;background:var(--b3-menu-background);border:1px solid var(--b3-border-color);border-radius:6px;padding:10px;box-shadow:var(--b3-dialog-shadow);min-width:240px";
    const r = anchorEl.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 260) + "px";
    pop.style.top = (r.bottom + 4) + "px";
    pop.appendChild(prop.edit(null, meta));
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;margin-top:8px;justify-content:flex-end";
    const cancel = document.createElement("button");
    cancel.className = "b3-button b3-button--cancel";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.className = "b3-button b3-button--text";
    save.textContent = "Save";
    const close = () => pop.remove();
    cancel.onclick = close;
    save.onclick = () => {
        const newMeta = (pop.firstChild as unknown as {getMeta?: () => unknown}).getMeta?.();
        if (!newMeta) { save.textContent = "bad coords"; return; }
        const out = prop.serialize ? prop.serialize(newMeta) : "";
        const data = cellVal ? JSON.parse(JSON.stringify(cellVal)) as AvCellValue : {} as AvCellValue;
        data.type = "text";
        (data as {text?: {content: string}}).text = {content: out};
        ctx.av!.setCell({avID: avId, rowID: rowId, keyID: keyId, cellID: cellId, data})
            .then(() => { close(); rerender(); })
            .catch((e: Error) => { save.textContent = "ERR: " + e.message; });
    };
    bar.append(cancel, save);
    pop.appendChild(bar);
    document.body.appendChild(pop);
};

// Build a task chip: drag-to-reschedule + (when reminderKey is set) a reminder
// affordance that opens the editor popover. Shared by month + range grids.
const makeChip = (
    it: CalItem, onDragStart: (it: CalItem) => void,
    avId: string, reminderKey: string | undefined, ctx: SuperBlockCtx, rerender: () => void,
): HTMLElement => {
    const chip = document.createElement("div");
    chip.style.cssText = "background:var(--b3-theme-primary);color:#fff;border-radius:3px;padding:1px 3px;margin-top:2px;cursor:grab;display:flex;align-items:center;gap:4px";
    chip.draggable = true;
    chip.ondragstart = () => onDragStart(it);
    const title = document.createElement("span");
    title.textContent = it.title;
    title.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    chip.appendChild(title);
    if (reminderKey) {
        const bell = document.createElement("span");
        bell.textContent = it.reminderRaw ? "🔔" : "+";
        bell.title = "Edit reminder";
        bell.draggable = false;
        bell.style.cssText = "cursor:pointer;font-size:10px;opacity:.9";
        bell.onclick = (e) => { e.stopPropagation(); openReminderEditor(chip, it, avId, reminderKey, ctx, rerender); };
        chip.appendChild(bell);
    }
    return chip;
};

// Render a month grid into `container` with drag-to-reschedule; `rerender`
// refreshes the whole view after a date write. Shared by calendar + database.
const renderMonthGrid = (
    container: HTMLElement, items: CalItem[], avId: string, dateKey: string,
    ctx: SuperBlockCtx, rerender: () => void, anchorTs?: number, reminderKey?: string,
) => {
    let dragRow: string | null = null;
    let dragCell = "";
    let dragVal: AvCellValue | null = null;
    const base = anchorTs ? new Date(anchorTs) : (items.length ? new Date(items[0].ts) : new Date());
    const y = base.getFullYear();
    const m = base.getMonth();
    const startDay = new Date(y, m, 1).getDay();
    const dim = new Date(y, m + 1, 0).getDate();
    const byDay: Record<number, CalItem[]> = {};
    items.forEach((it) => {
        const d = new Date(it.ts);
        if (d.getFullYear() === y && d.getMonth() === m) {
            (byDay[d.getDate()] = byDay[d.getDate()] || []).push(it);
        }
    });
    const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const h = document.createElement("div");
    h.textContent = `${mn[m]} ${y}`;
    h.style.cssText = "font-weight:bold;margin:4px 0";
    container.appendChild(h);
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);gap:2px";
    ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].forEach((d) => {
        const c = document.createElement("div");
        c.textContent = d;
        c.style.cssText = "font-size:11px;opacity:.6;text-align:center";
        grid.appendChild(c);
    });
    for (let i = 0; i < startDay; i++) {
        grid.appendChild(document.createElement("div"));
    }
    for (let day = 1; day <= dim; day++) {
        ((dd: number) => {
            const cell = document.createElement("div");
            cell.style.cssText = "min-height:46px;border:1px solid var(--b3-border-color);border-radius:4px;padding:2px;font-size:11px";
            cell.ondragover = (e) => { e.preventDefault(); cell.style.background = "var(--b3-theme-primary-lightest)"; };
            cell.ondragleave = () => { cell.style.background = ""; };
            cell.ondrop = (e) => {
                e.preventDefault();
                cell.style.background = "";
                if (!dragRow || !dragVal) { return; }
                const nd = JSON.parse(JSON.stringify(dragVal)) as AvCellValue;
                nd.date = nd.date || {content: 0, isNotEmpty: true};
                nd.date.content = new Date(y, m, dd, 12).getTime();
                nd.date.isNotEmpty = true;
                ctx.av!.setCell({avID: avId, rowID: dragRow, keyID: dateKey, cellID: dragCell, data: nd}).then(rerender);
                dragRow = null;
            };
            const num = document.createElement("div");
            num.textContent = String(dd);
            num.style.opacity = ".5";
            cell.appendChild(num);
            (byDay[dd] || []).forEach((it) => {
                cell.appendChild(makeChip(it, (i) => { dragRow = i.rowId; dragCell = i.cellId; dragVal = i.val; }, avId, reminderKey, ctx, rerender));
            });
            grid.appendChild(cell);
        })(day);
    }
    container.appendChild(grid);
};

// Calendar view state: which sub-view, how many days for the N-days mode, and
// the anchor timestamp (0 = "not yet set" → seeded from the first item on first draw).
type CalState = {mode: string; days: number; anchor: number};

// Render N consecutive days as columns (day = 1, week = 7, multi = N). Sunday-first
// for week mode is handled by the caller (it passes the Sunday as startTs). Same
// drag-to-reschedule contract as the month grid.
const renderRangeGrid = (
    container: HTMLElement, items: CalItem[], days: number, startTs: number,
    avId: string, dateKey: string, ctx: SuperBlockCtx, rerender: () => void, reminderKey?: string,
) => {
    let dragRow: string | null = null;
    let dragCell = "";
    let dragVal: AvCellValue | null = null;
    const start = new Date(startTs);
    start.setHours(0, 0, 0, 0);
    const keyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const byDay: Record<string, CalItem[]> = {};
    items.forEach((it) => {
        const d = new Date(it.ts);
        (byDay[keyOf(d)] = byDay[keyOf(d)] || []).push(it);
    });
    const dow = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    const grid = document.createElement("div");
    grid.style.cssText = `display:grid;grid-template-columns:repeat(${days},1fr);gap:2px`;
    for (let i = 0; i < days; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const col = document.createElement("div");
        col.style.cssText = "min-height:120px;border:1px solid var(--b3-border-color);border-radius:4px;padding:2px;font-size:11px";
        const hd = document.createElement("div");
        hd.textContent = `${dow[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
        hd.style.cssText = "font-weight:bold;opacity:.7;margin-bottom:2px";
        col.appendChild(hd);
        col.ondragover = (e) => { e.preventDefault(); col.style.background = "var(--b3-theme-primary-lightest)"; };
        col.ondragleave = () => { col.style.background = ""; };
        col.ondrop = (e) => {
            e.preventDefault();
            col.style.background = "";
            if (!dragRow || !dragVal) { return; }
            const nd = JSON.parse(JSON.stringify(dragVal)) as AvCellValue;
            nd.date = nd.date || {content: 0, isNotEmpty: true};
            nd.date.content = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
            nd.date.isNotEmpty = true;
            ctx.av!.setCell({avID: avId, rowID: dragRow, keyID: dateKey, cellID: dragCell, data: nd}).then(rerender);
            dragRow = null;
        };
        (byDay[keyOf(d)] || []).forEach((it) => {
            col.appendChild(makeChip(it, (i) => { dragRow = i.rowId; dragCell = i.cellId; dragVal = i.val; }, avId, reminderKey, ctx, rerender));
        });
        grid.appendChild(col);
    }
    container.appendChild(grid);
};

// Calendar with a sub-view toolbar (month / week / day / N-days) + prev/next nav.
// `state` lives in the caller's closure so it survives data re-renders (drag writes).
// Toolbar clicks only redraw the grid (no refetch); drags call `dataRerender`.
const renderCalendar = (
    container: HTMLElement, items: CalItem[], avId: string, dateKey: string,
    ctx: SuperBlockCtx, dataRerender: () => void, state: CalState, reminderKey?: string,
    onExport?: () => void,
) => {
    if (!state.anchor) { state.anchor = items.length ? items[0].ts : Date.now(); }
    const shift = (dir: number) => {
        const d = new Date(state.anchor);
        if (state.mode === "month") { d.setMonth(d.getMonth() + dir); }
        else if (state.mode === "week") { d.setDate(d.getDate() + 7 * dir); }
        else if (state.mode === "day") { d.setDate(d.getDate() + dir); }
        else { d.setDate(d.getDate() + state.days * dir); }
        state.anchor = d.getTime();
        draw();
    };
    const draw = () => {
        container.innerHTML = "";
        const bar = document.createElement("div");
        bar.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap";
        ([["month", "Month"], ["week", "Week"], ["day", "Day"], ["days", "N days"]] as Array<[string, string]>).forEach(([m, label]) => {
            const btn = document.createElement("button");
            btn.textContent = label;
            btn.className = "b3-button " + (m === state.mode ? "b3-button--text" : "b3-button--outline");
            btn.onclick = () => { state.mode = m; draw(); };
            bar.appendChild(btn);
        });
        if (state.mode === "days") {
            const inp = document.createElement("input");
            inp.type = "number";
            inp.min = "1";
            inp.value = String(state.days);
            inp.className = "b3-text-field";
            inp.style.width = "56px";
            inp.onchange = () => { state.days = Math.max(1, Number(inp.value) || 1); draw(); };
            bar.appendChild(inp);
        }
        const prev = document.createElement("button");
        prev.textContent = "‹";
        prev.className = "b3-button b3-button--outline";
        prev.onclick = () => shift(-1);
        const next = document.createElement("button");
        next.textContent = "›";
        next.className = "b3-button b3-button--outline";
        next.onclick = () => shift(1);
        bar.appendChild(prev);
        bar.appendChild(next);
        if (onExport) {
            const exp = document.createElement("button");
            exp.textContent = "⤓ .ics";
            exp.title = "Export tasks to an .ics calendar file";
            exp.className = "b3-button b3-button--outline";
            exp.onclick = onExport;
            bar.appendChild(exp);
        }
        container.appendChild(bar);
        const body = document.createElement("div");
        container.appendChild(body);
        if (state.mode === "month") {
            renderMonthGrid(body, items, avId, dateKey, ctx, dataRerender, state.anchor, reminderKey);
            return;
        }
        let days = 1;
        let startTs = state.anchor;
        if (state.mode === "week") {
            days = 7;
            const d = new Date(state.anchor);
            d.setDate(d.getDate() - d.getDay()); // back up to Sunday
            startTs = d.getTime();
        } else if (state.mode === "days") {
            days = state.days;
        }
        renderRangeGrid(body, items, days, startTs, avId, dateKey, ctx, dataRerender, reminderKey);
    };
    draw();
};

const calendarRun = (ctx: SuperBlockCtx, cfg: Record<string, unknown>) => {
    const el = ctx.el as HTMLElement;
    const avId = String(cfg.db || "");
    const dateKey = String(cfg.dateCol || "");
    if (!avId || !dateKey) {
        el.textContent = "Calendar — pick a database and date column in block settings.";
        return;
    }
    const reminderKey = String(cfg.reminderCol || "") || undefined;
    if (reminderKey) { startReminderScheduler(ctx, avId, dateKey, reminderKey); }
    const calState: CalState = {mode: String(cfg.view || "month"), days: Number(cfg.days || 3), anchor: 0};
    const render = () => {
        ctx.av!.read(avId).then((view) => {
            el.innerHTML = "";
            const rows = view.rows as AvRow[];
            renderCalendar(el, buildCalItems(rows, dateKey, reminderKey), avId, dateKey, ctx, render, calState, reminderKey,
                () => downloadText("tasks.ics", icsFromRows(rows as Parameters<typeof icsFromRows>[0], dateKey, reminderKey, "SiYuan Tasks")));
        }).catch((e: Error) => { el.textContent = "ERR: " + e.message; });
    };
    render();
    ctx.watch?.(render);
};

// Board view: group rows into columns by a chosen column's value (Trello/Kanban
// style). Cards show the row title. When the group column is text, dragging a card
// to another column writes that column's value back via ctx.av.setCell.
const renderBoard = (
    container: HTMLElement, columns: Array<{id: string; name: string; type: string}>, rows: AvRow[],
    avId: string, groupKey: string, ctx: SuperBlockCtx, rerender: () => void,
) => {
    const groupCol = columns.find((c) => c.id === groupKey);
    const groupType = groupCol ? groupCol.type : "";
    const groups: Record<string, AvRow[]> = {};
    const order: string[] = [];
    rows.forEach((r) => {
        const gc = r.cells.find((c) => c.value && c.value.keyID === groupKey);
        const key = (gc && avCellText(gc.value)) || "(empty)";
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(r);
    });
    let dragRow: string | null = null;
    let dragCellId = "";
    let dragVal: AvCellValue | null = null;
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:8px;align-items:flex-start;overflow-x:auto";
    order.forEach((key) => {
        const colEl = document.createElement("div");
        colEl.style.cssText = "min-width:140px;flex:0 0 auto;border:1px solid var(--b3-border-color);border-radius:6px;padding:4px";
        const hd = document.createElement("div");
        hd.textContent = `${key}  (${groups[key].length})`;
        hd.style.cssText = "font-weight:bold;font-size:11px;margin-bottom:4px";
        colEl.appendChild(hd);
        if (groupType === "text") {
            colEl.ondragover = (e) => { e.preventDefault(); colEl.style.background = "var(--b3-theme-primary-lightest)"; };
            colEl.ondragleave = () => { colEl.style.background = ""; };
            colEl.ondrop = (e) => {
                e.preventDefault();
                colEl.style.background = "";
                if (!dragRow) { return; }
                const nd = dragVal ? JSON.parse(JSON.stringify(dragVal)) as AvCellValue : {} as AvCellValue;
                nd.type = "text";
                (nd as {text?: {content: string}}).text = {content: key === "(empty)" ? "" : key};
                ctx.av!.setCell({avID: avId, rowID: dragRow, keyID: groupKey, cellID: dragCellId, data: nd}).then(rerender);
                dragRow = null;
            };
        }
        groups[key].forEach((r) => {
            const tc = r.cells.find((c) => c.value && c.value.type === "block");
            const card = document.createElement("div");
            card.textContent = (tc && tc.value.block && tc.value.block.content) || "(row)";
            card.style.cssText = "background:var(--b3-theme-background);border:1px solid var(--b3-border-color);border-radius:4px;padding:2px 4px;margin-top:3px;font-size:11px";
            if (groupType === "text") {
                card.draggable = true;
                card.style.cursor = "grab";
                const gc = r.cells.find((c) => c.value && c.value.keyID === groupKey);
                card.ondragstart = () => { dragRow = r.id; dragCellId = gc ? gc.id : ""; dragVal = gc ? gc.value : null; };
            }
            colEl.appendChild(card);
        });
        wrap.appendChild(colEl);
    });
    container.appendChild(wrap);
};

// Database multi-view: a runtime view switcher (table / calendar / board) over one
// database, reusing the shared month grid. The "change view" feature.
const dbRun = (ctx: SuperBlockCtx, cfg: Record<string, unknown>) => {
    const el = ctx.el as HTMLElement;
    const avId = String(cfg.db || "");
    const dateKey = String(cfg.dateCol || "");
    if (!avId) {
        el.textContent = "Database — pick a database in block settings.";
        return;
    }
    let active = String(cfg.view || "table");
    const reminderKey = String(cfg.reminderCol || "") || undefined;
    const locationKey = String(cfg.locationCol || "") || undefined;
    const groupKey = String(cfg.groupCol || "") || undefined;
    if (reminderKey && dateKey) { startReminderScheduler(ctx, avId, dateKey, reminderKey); }
    const calState: CalState = {mode: String(cfg.calView || "month"), days: Number(cfg.days || 3), anchor: 0};
    const render = () => {
        ctx.av!.read(avId).then((view) => {
            const columns = view.columns as Array<{id: string; name: string; type: string}>;
            const rows = view.rows as AvRow[];
            el.innerHTML = "";
            const bar = document.createElement("div");
            bar.style.cssText = "display:flex;gap:6px;margin-bottom:6px";
            ["table", "calendar", "board"].forEach((vname) => {
                const btn = document.createElement("button");
                btn.textContent = vname;
                btn.className = "b3-button " + (vname === active ? "b3-button--text" : "b3-button--outline");
                btn.onclick = () => { active = vname; render(); };
                bar.appendChild(btn);
            });
            el.appendChild(bar);
            const body = document.createElement("div");
            el.appendChild(body);
            if (active === "calendar") {
                if (!dateKey) { body.textContent = "Calendar view needs a date column (set it in settings)."; return; }
                renderCalendar(body, buildCalItems(rows, dateKey, reminderKey), avId, dateKey, ctx, render, calState, reminderKey,
                    () => downloadText("tasks.ics", icsFromRows(rows as Parameters<typeof icsFromRows>[0], dateKey, reminderKey, "SiYuan Tasks")));
                return;
            }
            if (active === "board") {
                if (!groupKey) { body.textContent = "Board view needs a group column (set it in settings)."; return; }
                renderBoard(body, columns, rows, avId, groupKey, ctx, render);
                return;
            }
            const table = document.createElement("table");
            table.style.cssText = "border-collapse:collapse;font-size:12px";
            const head = document.createElement("tr");
            columns.forEach((c) => {
                const th = document.createElement("th");
                th.textContent = c.name;
                th.style.cssText = "border:1px solid var(--b3-border-color);padding:2px 6px;text-align:left";
                head.appendChild(th);
            });
            table.appendChild(head);
            rows.forEach((r) => {
                const tr = document.createElement("tr");
                columns.forEach((c) => {
                    const cellEl = r.cells.find((cc) => cc.value && cc.value.keyID === c.id);
                    const td = document.createElement("td");
                    td.style.cssText = "border:1px solid var(--b3-border-color);padding:2px 6px";
                    if (locationKey && c.id === locationKey) {
                        const prop = getProperty("location");
                        const raw = (cellEl && (cellEl.value as {text?: {content?: string}}).text?.content) || "";
                        const meta = prop && prop.parse ? prop.parse(raw) : null;
                        const view = prop && prop.render ? prop.render(cellEl ? cellEl.value : null, meta) : document.createElement("span");
                        view.style.cursor = "pointer";
                        view.onclick = () => openLocationEditor(td, raw, avId, r.id, locationKey, cellEl ? cellEl.id : "", cellEl ? cellEl.value : null, ctx, render);
                        td.appendChild(view);
                    } else {
                        td.textContent = cellEl ? avCellText(cellEl.value) : "";
                    }
                    tr.appendChild(td);
                });
                table.appendChild(tr);
            });
            body.appendChild(table);
        }).catch((e: Error) => { el.textContent = "ERR: " + e.message; });
    };
    render();
    ctx.watch?.(render);
};

// Embed: display another block here. "editable" mounts a real nested Protyle via
// the embed capability (two-way, unlike SiYuan's read-only embed); "readonly"
// fetches the target's markdown as a static snapshot. Advanced transclusion
// (heading/section scope, block-ref resolution, query-result embeds) builds on this.
const embedRun = (ctx: SuperBlockCtx, cfg: Record<string, unknown>) => {
    const el = ctx.el as HTMLElement;
    const target = String(cfg.target || "").trim();
    const view = String(cfg.view || "iframe");   // iframe | editable | readonly
    if (!target) {
        el.textContent = "Embed — set a target block id in block settings.";
        return;
    }
    if (view === "readonly") {
        const render = () => {
            el.innerHTML = "";
            const safeId = target.replace(/'/g, "");
            ctx.api!.post!("/api/query/sql", {stmt: `SELECT markdown, content FROM blocks WHERE id='${safeId}'`}).then((r: IWebSocketData) => {
                const row = ((r.data as Array<Record<string, unknown>>) || [])[0];
                const box = document.createElement("div");
                box.style.cssText = "border:1px solid var(--b3-border-color);border-radius:4px;padding:6px;font-size:13px;white-space:pre-wrap";
                box.textContent = row ? String(row.markdown || row.content || "") : "(block not found)";
                el.appendChild(box);
            }).catch((e: Error) => { el.textContent = "ERR: " + e.message; });
        };
        render();
        ctx.watch?.(render);   // cheap re-fetch; safe to refresh
        return;
    }
    el.innerHTML = "";
    // Default: isolated iframe — the SAME mechanism SiYuan uses to open a block/page
    // in a new window (window.html?json=…), just hosted inline. Separate browsing
    // context ⇒ none of the host-input-pipeline problems.
    if (view === "iframe") {
        if (ctx.embedFrame) { ctx.embedFrame(target); } else { el.textContent = "embed capability unavailable"; }
        return;
    }
    // "editable" = in-page nested Protyle (lighter, but shares the host's event scope;
    // kept as an option). Mount ONCE — re-rendering on ctx.watch would loop.
    if (ctx.embed) { ctx.embed(target); } else { el.textContent = "embed capability unavailable"; }
};

export const registerBuiltinFeatures = () => {
    // ---------------------------------------------------------------------
    // FROZEN (see featureFlags.ts): the calendar + database multi-view are the
    // task/calendar track, paused on user request. While isFrozen() is true they
    // are NOT registered, so they never appear in the picker and their run()
    // (which also starts the ReminderScheduler) never executes. The functions
    // calendarRun / dbRun / renderCalendar / renderBoard / startReminderScheduler
    // above remain compiled but unreachable. Flip featureFlags to revive.
    // ---------------------------------------------------------------------
    if (!isFrozen()) {
        registerFeature({
            id: "calendar",
            label: "Calendar",
            caps: ["ui", "av", "watch", "timers"],
            configSchema: [
                {key: "db", label: "Database", type: "av-database"},
                {key: "dateCol", label: "Date column", type: "av-column", ofKey: "db"},
                {key: "reminderCol", label: "Reminder column (text companion)", type: "av-column", ofKey: "db"},
                {key: "view", label: "Default sub-view", type: "select", options: [{value: "month", label: "Month"}, {value: "week", label: "Week"}, {value: "day", label: "Day"}, {value: "days", label: "N days"}]},
                {key: "days", label: "Days (for N-days view)", type: "number"},
            ],
            run: calendarRun,
        });
        registerFeature({
            id: "database",
            label: "Database (multi-view)",
            caps: ["ui", "av", "watch", "timers"],
            configSchema: [
                {key: "db", label: "Database", type: "av-database"},
                {key: "dateCol", label: "Date column (for calendar view)", type: "av-column", ofKey: "db"},
                {key: "reminderCol", label: "Reminder column (text companion)", type: "av-column", ofKey: "db"},
                {key: "locationCol", label: "Location column (text)", type: "av-column", ofKey: "db"},
                {key: "groupCol", label: "Group column (for board view)", type: "av-column", ofKey: "db"},
                {key: "view", label: "Default view", type: "select", options: [{value: "table", label: "Table"}, {value: "calendar", label: "Calendar"}, {value: "board", label: "Board"}]},
                {key: "calView", label: "Calendar sub-view", type: "select", options: [{value: "month", label: "Month"}, {value: "week", label: "Week"}, {value: "day", label: "Day"}, {value: "days", label: "N days"}]},
                {key: "days", label: "Days (for N-days view)", type: "number"},
            ],
            run: dbRun,
        });
    }
    // ACTIVE FOCUS: search/query (below) + embed (see registerEmbedFeature).
    registerFeature({
        id: "query",
        label: "Query / Search",
        caps: ["api", "ui", "watch", "embed"],
        defaultConfig: {source: "sql", query: "SELECT id, content FROM blocks WHERE content != '' ORDER BY updated DESC LIMIT 10", mode: "table"},
        configSchema: [
            {key: "source", label: "Source", type: "select", options: [{value: "sql", label: "SQL"}, {value: "fulltext", label: "Full-text search"}]},
            {key: "query", label: "Query (SQL statement or search terms)", type: "code"},
            {key: "mode", label: "View", type: "select", options: [{value: "table", label: "Table"}, {value: "list", label: "List"}, {value: "embed", label: "Editable blocks"}]},
            {key: "groupBy", label: "Group by (column name, optional)", type: "text"},
        ],
        run: queryRun,
    });
    registerFeature({
        id: "embed",
        label: "Embed",
        caps: ["ui", "embed", "watch", "api"],
        defaultConfig: {view: "iframe"},
        configSchema: [
            {key: "target", label: "Target block id", type: "text"},
            {key: "view", label: "Mode", type: "select", options: [{value: "iframe", label: "Isolated window (recommended)"}, {value: "editable", label: "Inline editor"}, {value: "readonly", label: "Read-only"}]},
        ],
        run: embedRun,
    });
};
