// Super-block view engine (notes/15) — pure, capability-free helpers shared by
// data features (query, database, …): filter / sort / group / manual-order. A
// feature normalizes its source into ViewRecord[] then runs applyView(records,
// viewConfig). Exposed on window.siyuan.superblock.view so any feature reuses it.

export interface ViewRecord { id: string; values: Record<string, unknown>; }
export interface SortKey { field: string; dir: "asc" | "desc"; }
export interface FilterRule { field: string; op: string; value?: unknown; }
export interface FilterGroup { op: "and" | "or"; rules: FilterRule[]; }
export interface ViewConfig {
    sort?: SortKey[];
    filter?: FilterGroup;
    group?: string | null;
    order?: "manual" | "byField";
    manualOrder?: string[];
}

const matchRule = (rec: ViewRecord, rule: FilterRule): boolean => {
    const v = rec.values[rule.field];
    switch (rule.op) {
        case "eq": return v === rule.value;
        case "ne": return v !== rule.value;
        case "contains": return String(v ?? "").toLowerCase().includes(String(rule.value ?? "").toLowerCase());
        case "gt": return Number(v) > Number(rule.value);
        case "lt": return Number(v) < Number(rule.value);
        case "gte": return Number(v) >= Number(rule.value);
        case "lte": return Number(v) <= Number(rule.value);
        case "empty": return v == null || v === "";
        case "notEmpty": return !(v == null || v === "");
        default: return true;
    }
};

export const applyFilter = (records: ViewRecord[], filter?: FilterGroup): ViewRecord[] => {
    if (!filter || !filter.rules || filter.rules.length === 0) {
        return records;
    }
    return records.filter((rec) => {
        const results = filter.rules.map((r) => matchRule(rec, r));
        return filter.op === "or" ? results.some(Boolean) : results.every(Boolean);
    });
};

export const applySort = (records: ViewRecord[], sort?: SortKey[]): ViewRecord[] => {
    if (!sort || sort.length === 0) {
        return records;
    }
    return records.slice().sort((a, b) => {
        for (const k of sort) {
            const av = a.values[k.field];
            const bv = b.values[k.field];
            let c: number;
            if (typeof av === "string" && typeof bv === "string") {
                c = av.localeCompare(bv);
            } else {
                c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1;
            }
            if (k.dir === "desc") {
                c = -c;
            }
            if (c !== 0) {
                return c;
            }
        }
        return 0;
    });
};

export const applyManualOrder = (records: ViewRecord[], order?: string[]): ViewRecord[] => {
    if (!order || order.length === 0) {
        return records;
    }
    const idx = new Map(order.map((id, i) => [id, i]));
    return records.slice().sort((a, b) =>
        (idx.has(a.id) ? idx.get(a.id)! : 1e9) - (idx.has(b.id) ? idx.get(b.id)! : 1e9));
};

export const applyGroup = (records: ViewRecord[], field: string): Record<string, ViewRecord[]> => {
    const groups: Record<string, ViewRecord[]> = {};
    records.forEach((rec) => {
        const key = String(rec.values[field] ?? "");
        (groups[key] = groups[key] || []).push(rec);
    });
    return groups;
};

// The pipeline: filter → (manual order | sort) → optional group.
export const applyView = (records: ViewRecord[], view: ViewConfig): ViewRecord[] | Record<string, ViewRecord[]> => {
    let out = applyFilter(records, view.filter);
    out = (view.order === "manual" && view.manualOrder) ? applyManualOrder(out, view.manualOrder) : applySort(out, view.sort);
    return view.group ? applyGroup(out, view.group) : out;
};
