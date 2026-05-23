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

const calendarRun = (ctx: SuperBlockCtx, cfg: Record<string, unknown>) => {
    const el = ctx.el as HTMLElement;
    const avId = String(cfg.db || "");
    const dateKey = String(cfg.dateCol || "");
    if (!avId || !dateKey) {
        el.textContent = "Calendar — pick a database and date column in block settings.";
        return;
    }
    let dragRow: string | null = null;
    let dragCell = "";
    let dragVal: AvCellValue | null = null;
    const render = () => {
        ctx.av!.read(avId).then((view) => {
            const rows = view.rows as AvRow[];
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
            const base = items.length ? new Date(items[0].ts) : new Date();
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
            el.innerHTML = "";
            const h = document.createElement("div");
            h.textContent = `${mn[m]} ${y}`;
            h.style.cssText = "font-weight:bold;margin:4px 0";
            el.appendChild(h);
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
                        ctx.av!.setCell({avID: avId, rowID: dragRow, keyID: dateKey, cellID: dragCell, data: nd}).then(render);
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
            el.appendChild(grid);
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
        ],
        run: calendarRun,
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
