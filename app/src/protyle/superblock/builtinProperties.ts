// Built-in property components (notes/16). A property component is a value-level
// extension bound to ONE column: it renders + edits a richer value than the raw
// cell, storing the cohesive part as self-describing JSON ($schema + _type) in a
// companion text column. The canonical native column (here a `date`) stays plain.
// Ported reminder-offset logic from siyuan-plugin-tasks (src/reminder/scheduler.ts).

import {registerProperty} from "./runtime";

export const REMINDER_SCHEMA = "siyuan-superblock/reminder@1";

export interface ReminderMeta {
    relative?: string[];     // compact offsets from the canonical date: "-15m", "-1d 2h" (— = before)
    remindAt?: number[];     // absolute fire times, epoch ms
    rrule?: string;          // repeat, iCal RRULE subset, e.g. "FREQ=WEEKLY"
    exceptions?: number[];   // excluded occurrence starts, epoch ms
}

const UNIT_MIN: Record<string, number> = {w: 10080, d: 1440, h: 60, m: 1, s: 1 / 60};

// "-1d 2h" → signed minutes (negative = before). null if no recognizable token.
export const offsetToMinutes = (s: string): number | null => {
    const t = (s || "").trim().toLowerCase();
    if (!t) {
        return null;
    }
    const sign = t.startsWith("-") ? -1 : 1;
    const re = /(\d+)\s*([wdhms])/g;
    let total = 0;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
        total += parseInt(m[1], 10) * UNIT_MIN[m[2]];
        matched = true;
    }
    return matched ? sign * total : null;
};

const fmtOffset = (s: string): string => {
    const min = offsetToMinutes(s);
    if (min === null) {
        return s;
    }
    const abs = Math.abs(min);
    const label = abs >= 1440 && abs % 1440 === 0 ? `${abs / 1440}d`
        : abs >= 60 && abs % 60 === 0 ? `${abs / 60}h`
            : `${abs}m`;
    return abs === 0 ? "at time" : (min < 0 ? `${label} before` : `${label} after`);
};

export const parseReminderMeta = (raw: string): ReminderMeta => {
    if (!raw) {
        return {};
    }
    try {
        const o = JSON.parse(raw);
        return (o && typeof o === "object") ? o as ReminderMeta : {};
    } catch {
        return {};
    }
};

export const serializeReminderMeta = (meta: ReminderMeta): string => {
    const clean: ReminderMeta = {};
    if (meta.relative && meta.relative.length) { clean.relative = meta.relative; }
    if (meta.remindAt && meta.remindAt.length) { clean.remindAt = meta.remindAt; }
    if (meta.rrule) { clean.rrule = meta.rrule; }
    if (meta.exceptions && meta.exceptions.length) { clean.exceptions = meta.exceptions; }
    return JSON.stringify({$schema: REMINDER_SCHEMA, _type: "reminder", ...clean});
};

const summarize = (meta: ReminderMeta): string => {
    const parts: string[] = [];
    (meta.relative || []).forEach((r) => parts.push(fmtOffset(r)));
    (meta.remindAt || []).forEach((t) => parts.push(new Date(t).toLocaleString()));
    if (meta.rrule) { parts.push(meta.rrule.replace("FREQ=", "").toLowerCase()); }
    return parts.length ? "🔔 " + parts.join(", ") : "🔔 set reminder";
};

const renderReminder = (_cell: unknown, meta: unknown): HTMLElement => {
    const el = document.createElement("span");
    el.textContent = summarize((meta as ReminderMeta) || {});
    el.style.cssText = "font-size:11px;opacity:.85";
    return el;
};

const PRESETS: Record<string, string> = {
    "At time": "-0m", "10 min before": "-10m", "1 hour before": "-1h", "1 day before": "-1d",
};

const labelRow = (text: string, control: HTMLElement): HTMLElement => {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;flex-direction:column;gap:2px";
    const lb = document.createElement("span");
    lb.textContent = text;
    lb.style.cssText = "font-size:11px;opacity:.6";
    row.append(lb, control);
    return row;
};

// The editor returns a DOM node carrying a `getMeta()` the host calls on save.
const editReminder = (_cell: unknown, metaIn: unknown): HTMLElement => {
    const meta: ReminderMeta = {...((metaIn as ReminderMeta) || {})};
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;font-size:12px";

    const rel = document.createElement("input");
    rel.className = "b3-text-field";
    rel.placeholder = "relative e.g. -15m, -1d";
    rel.value = (meta.relative || []).join(", ");

    const presetRow = document.createElement("div");
    Object.keys(PRESETS).forEach((label) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = "b3-button b3-button--outline";
        b.style.cssText = "margin:0 4px 4px 0;font-size:11px";
        b.onclick = () => { rel.value = rel.value ? rel.value + ", " + PRESETS[label] : PRESETS[label]; };
        presetRow.appendChild(b);
    });

    const abs = document.createElement("input");
    abs.type = "datetime-local";
    abs.className = "b3-text-field";
    if (meta.remindAt && meta.remindAt[0]) {
        const d = new Date(meta.remindAt[0] - new Date().getTimezoneOffset() * 60000);
        abs.value = d.toISOString().slice(0, 16);
    }

    const rep = document.createElement("select");
    rep.className = "b3-select";
    ([["", "No repeat"], ["FREQ=DAILY", "Daily"], ["FREQ=WEEKLY", "Weekly"], ["FREQ=MONTHLY", "Monthly"]] as Array<[string, string]>)
        .forEach(([v, l]) => {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = l;
            if (meta.rrule === v) { o.selected = true; }
            rep.appendChild(o);
        });

    wrap.append(labelRow("Quick presets", presetRow), labelRow("Relative", rel), labelRow("At date/time", abs), labelRow("Repeat", rep));

    (wrap as unknown as {getMeta: () => ReminderMeta}).getMeta = (): ReminderMeta => {
        const out: ReminderMeta = {};
        const rels = rel.value.split(",").map((s) => s.trim()).filter(Boolean).filter((s) => offsetToMinutes(s) !== null);
        if (rels.length) { out.relative = rels; }
        if (abs.value) { const t = new Date(abs.value).getTime(); if (!isNaN(t)) { out.remindAt = [t]; } }
        if (rep.value) { out.rrule = rep.value; }
        return out;
    };
    return wrap;
};

export const registerBuiltinProperties = () => {
    registerProperty({
        id: "reminder",
        label: "Reminder",
        baseType: "date",
        metaSchemaId: REMINDER_SCHEMA,
        parse: parseReminderMeta,
        serialize: (m) => serializeReminderMeta(m as ReminderMeta),
        render: renderReminder,
        edit: editReminder,
    });
};
