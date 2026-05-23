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

export const registerBuiltinFeatures = () => {
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
