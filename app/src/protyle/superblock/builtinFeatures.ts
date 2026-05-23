// Built-in super-block features (notes/14 L2, notes/15 catalog). A small core set
// registered at init so they're usable out of the box and survive reload; plugins
// add more via window.siyuan.superblock.registerFeature. Each is config-driven.

import {registerFeature, SuperBlockCtx} from "./runtime";
import {applyView, ViewRecord, ViewConfig} from "./viewEngine";

// Query / Search: config = a SQL query + view (filter/sort/group) + table|list mode.
// Reads via the gated api capability, normalizes rows, runs the shared view engine.
const queryRun = (ctx: SuperBlockCtx, cfg: Record<string, unknown>) => {
    const el = ctx.el as HTMLElement;
    const stmt = String(cfg.query || "SELECT content FROM blocks WHERE content != '' ORDER BY updated DESC LIMIT 10");
    const mode = String(cfg.mode || "table");
    const viewCfg = (cfg.view as ViewConfig) || {};
    const render = () => {
        el.textContent = "loading…";
        ctx.api!.post!("/api/query/sql", {stmt}).then((r: IWebSocketData) => {
            const rows = (r.data as Array<Record<string, unknown>>) || [];
            const records: ViewRecord[] = rows.map((row, i) => ({id: String(row.id || i), values: row}));
            const processed = applyView(records, viewCfg);
            const list: ViewRecord[] = Array.isArray(processed)
                ? processed
                : ([] as ViewRecord[]).concat(...Object.values(processed));
            el.innerHTML = "";
            if (list.length === 0) { el.textContent = "no results"; return; }
            const cols = Object.keys(list[0].values);
            if (mode === "list") {
                const ul = document.createElement("ul");
                list.forEach((rec) => {
                    const li = document.createElement("li");
                    li.textContent = String(rec.values[cols[0]] ?? "");
                    ul.appendChild(li);
                });
                el.appendChild(ul);
            } else {
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
                    cols.forEach((c) => {
                        const td = document.createElement("td");
                        td.textContent = String(rec.values[c] ?? "");
                        td.style.cssText = "border:1px solid var(--b3-border-color);padding:2px 6px";
                        tr.appendChild(td);
                    });
                    table.appendChild(tr);
                });
                el.appendChild(table);
            }
        }).catch((e: Error) => { el.textContent = "ERR: " + e.message; });
    };
    render();
    ctx.watch?.(render);
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
type CalItem = {title: string; ts: number; rowId: string; cellId: string; val: AvCellValue};

// Build calendar items (title + timestamp + cell ref) from a database's rows.
const buildCalItems = (rows: AvRow[], dateKey: string): CalItem[] => {
    const items: CalItem[] = [];
    rows.forEach((r) => {
        const tc = r.cells.find((c) => c.value && c.value.type === "block");
        const dc = r.cells.find((c) => c.value && c.value.keyID === dateKey);
        const title = (tc && tc.value.block && tc.value.block.content) || "(task)";
        const ts = (dc && dc.value.date && dc.value.date.isNotEmpty) ? dc.value.date.content : null;
        if (ts && dc) {
            items.push({title, ts, rowId: r.id, cellId: dc.id, val: dc.value});
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

// Render a month grid into `container` with drag-to-reschedule; `rerender`
// refreshes the whole view after a date write. Shared by calendar + database.
const renderMonthGrid = (
    container: HTMLElement, items: CalItem[], avId: string, dateKey: string,
    ctx: SuperBlockCtx, rerender: () => void, anchorTs?: number,
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
                const chip = document.createElement("div");
                chip.textContent = it.title;
                chip.draggable = true;
                chip.style.cssText = "background:var(--b3-theme-primary);color:#fff;border-radius:3px;padding:1px 3px;margin-top:2px;cursor:grab";
                chip.ondragstart = () => { dragRow = it.rowId; dragCell = it.cellId; dragVal = it.val; };
                cell.appendChild(chip);
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
    avId: string, dateKey: string, ctx: SuperBlockCtx, rerender: () => void,
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
            const chip = document.createElement("div");
            chip.textContent = it.title;
            chip.draggable = true;
            chip.style.cssText = "background:var(--b3-theme-primary);color:#fff;border-radius:3px;padding:1px 3px;margin-top:2px;cursor:grab";
            chip.ondragstart = () => { dragRow = it.rowId; dragCell = it.cellId; dragVal = it.val; };
            col.appendChild(chip);
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
    ctx: SuperBlockCtx, dataRerender: () => void, state: CalState,
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
        container.appendChild(bar);
        const body = document.createElement("div");
        container.appendChild(body);
        if (state.mode === "month") {
            renderMonthGrid(body, items, avId, dateKey, ctx, dataRerender, state.anchor);
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
        renderRangeGrid(body, items, days, startTs, avId, dateKey, ctx, dataRerender);
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
    const calState: CalState = {mode: String(cfg.view || "month"), days: Number(cfg.days || 3), anchor: 0};
    const render = () => {
        ctx.av!.read(avId).then((view) => {
            el.innerHTML = "";
            renderCalendar(el, buildCalItems(view.rows as AvRow[], dateKey), avId, dateKey, ctx, render, calState);
        }).catch((e: Error) => { el.textContent = "ERR: " + e.message; });
    };
    render();
    ctx.watch?.(render);
};

// Database multi-view: a runtime view switcher (table / calendar) over one
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
    const calState: CalState = {mode: String(cfg.calView || "month"), days: Number(cfg.days || 3), anchor: 0};
    const render = () => {
        ctx.av!.read(avId).then((view) => {
            const columns = view.columns as Array<{id: string; name: string; type: string}>;
            const rows = view.rows as AvRow[];
            el.innerHTML = "";
            const bar = document.createElement("div");
            bar.style.cssText = "display:flex;gap:6px;margin-bottom:6px";
            ["table", "calendar"].forEach((vname) => {
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
                renderCalendar(body, buildCalItems(rows, dateKey), avId, dateKey, ctx, render, calState);
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
                    td.textContent = cellEl ? avCellText(cellEl.value) : "";
                    td.style.cssText = "border:1px solid var(--b3-border-color);padding:2px 6px";
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

export const registerBuiltinFeatures = () => {
    registerFeature({
        id: "calendar",
        label: "Calendar",
        caps: ["ui", "av", "watch"],
        configSchema: [
            {key: "db", label: "Database", type: "av-database"},
            {key: "dateCol", label: "Date column", type: "av-column", ofKey: "db"},
            {key: "view", label: "Default sub-view", type: "select", options: [{value: "month", label: "Month"}, {value: "week", label: "Week"}, {value: "day", label: "Day"}, {value: "days", label: "N days"}]},
            {key: "days", label: "Days (for N-days view)", type: "number"},
        ],
        run: calendarRun,
    });
    registerFeature({
        id: "database",
        label: "Database (multi-view)",
        caps: ["ui", "av", "watch"],
        configSchema: [
            {key: "db", label: "Database", type: "av-database"},
            {key: "dateCol", label: "Date column (for calendar view)", type: "av-column", ofKey: "db"},
            {key: "view", label: "Default view", type: "select", options: [{value: "table", label: "Table"}, {value: "calendar", label: "Calendar"}]},
            {key: "calView", label: "Calendar sub-view", type: "select", options: [{value: "month", label: "Month"}, {value: "week", label: "Week"}, {value: "day", label: "Day"}, {value: "days", label: "N days"}]},
            {key: "days", label: "Days (for N-days view)", type: "number"},
        ],
        run: dbRun,
    });
    registerFeature({
        id: "query",
        label: "Query / Search",
        caps: ["api", "ui", "watch"],
        defaultConfig: {query: "SELECT content FROM blocks WHERE content != '' ORDER BY updated DESC LIMIT 10", mode: "table"},
        configSchema: [
            {key: "query", label: "SQL query", type: "code"},
            {key: "mode", label: "View", type: "select", options: [{value: "table", label: "Table"}, {value: "list", label: "List"}]},
        ],
        run: queryRun,
    });
};
