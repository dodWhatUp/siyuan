// Reminder engine (notes/16, P4) — pure functions that expand a repeat rule into
// occurrences and compute reminder fire-times. No DOM, no ctx, no AV: a feature or
// the scheduler feeds in a ReminderMeta + a time window and gets back fire-times.
// RRULE subset: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (weekly), COUNT, UNTIL.

import {ReminderMeta, offsetToMinutes} from "./builtinProperties";

export interface RRule {
    freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
    interval: number;
    byday?: number[];     // JS weekdays (Sun=0 … Sat=6)
    count?: number;
    until?: number;       // epoch ms
}

const DAY_MAP: Record<string, number> = {SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6};
const DAY_MS = 86400000;

export const parseRRule = (s?: string): RRule | null => {
    if (!s) {
        return null;
    }
    const parts: Record<string, string> = {};
    s.split(";").forEach((kv) => {
        const [k, v] = kv.split("=");
        if (k && v) { parts[k.trim().toUpperCase()] = v.trim(); }
    });
    const freq = parts.FREQ as RRule["freq"];
    if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
        return null;
    }
    const rule: RRule = {freq, interval: Math.max(1, parseInt(parts.INTERVAL || "1", 10) || 1)};
    if (parts.BYDAY) {
        rule.byday = parts.BYDAY.split(",").map((d) => DAY_MAP[d.trim().toUpperCase().slice(0, 2)]).filter((n) => n !== undefined);
    }
    if (parts.COUNT) { rule.count = parseInt(parts.COUNT, 10) || undefined; }
    if (parts.UNTIL) {
        const u = parts.UNTIL.replace(/[^0-9]/g, "");   // "20260604" or "20260604T120000Z" → digits
        if (u.length >= 8) {
            const hasTime = u.length >= 14;
            const t = new Date(
                +u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8),
                hasTime ? +u.slice(8, 10) : 23, hasTime ? +u.slice(10, 12) : 59, hasTime ? +u.slice(12, 14) : 59,
            ).getTime();   // date-only UNTIL = inclusive end-of-day (local)
            if (!isNaN(t)) { rule.until = t; }
        }
    }
    return rule;
};

// Expand occurrence START times (same clock time as the base) within [winStart, winEnd].
// No rule → the single base time (if in window).
export const expandOccurrences = (
    startTs: number, rule: RRule | null, winStart: number, winEnd: number, exceptions?: number[],
): number[] => {
    const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    const exDates = new Set((exceptions || []).map(ymd));   // skip by local date, not exact ms
    if (!rule) {
        return (startTs >= winStart && startTs <= winEnd && !exDates.has(ymd(startTs))) ? [startTs] : [];
    }
    const out: number[] = [];
    const base = new Date(startTs);
    const hh = base.getHours();
    const mm = base.getMinutes();
    const cap = rule.count && rule.count > 0 ? rule.count : Infinity;
    const MAX_ITER = 5000;
    let generated = 0;
    const push = (d: Date) => {
        const t = d.getTime();
        if (t < startTs) { return true; }
        if (rule.until && t > rule.until) { return false; }   // stop BEFORE pushing the over-limit occurrence
        generated++;
        if (t >= winStart && t <= winEnd && !exDates.has(ymd(t))) { out.push(t); }
        return generated < cap && t <= winEnd;
    };
    if (rule.freq === "WEEKLY" && rule.byday && rule.byday.length) {
        const days = rule.byday.slice().sort((a, b) => a - b);
        // start at the Sunday of the base week
        let weekStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() - base.getDay(), hh, mm);
        for (let i = 0; i < MAX_ITER; i++) {
            let cont = true;
            for (const wd of days) {
                const d = new Date(weekStart.getTime() + wd * DAY_MS);
                d.setHours(hh, mm, 0, 0);
                if (d.getTime() > winEnd && d.getTime() > startTs) { cont = false; break; }
                if (!push(d)) { cont = false; break; }
            }
            if (!cont) { break; }
            weekStart = new Date(weekStart.getTime() + rule.interval * 7 * DAY_MS);
            if (weekStart.getTime() > winEnd) { break; }
        }
        return out.sort((a, b) => a - b);
    }
    const cur = new Date(startTs);
    for (let i = 0; i < MAX_ITER; i++) {
        if (!push(new Date(cur))) { break; }
        if (rule.freq === "DAILY") { cur.setDate(cur.getDate() + rule.interval); }
        else if (rule.freq === "WEEKLY") { cur.setDate(cur.getDate() + rule.interval * 7); }
        else if (rule.freq === "MONTHLY") { cur.setMonth(cur.getMonth() + rule.interval); }
        else { cur.setFullYear(cur.getFullYear() + rule.interval); }
        cur.setHours(hh, mm, 0, 0);
        if (cur.getTime() > winEnd) { break; }
    }
    return out.sort((a, b) => a - b);
};

// All reminder fire-times in [winStart, winEnd] for a task whose date is baseTs:
// relative offsets applied to each occurrence + the absolute remindAt times.
export const upcomingFires = (
    baseTs: number, meta: ReminderMeta, winStart: number, winEnd: number,
): number[] => {
    const rule = parseRRule(meta.rrule);
    // expand a generous margin so a "1 day before" of an occurrence near the edges is captured
    const margin = 366 * DAY_MS;
    const occs = expandOccurrences(baseTs, rule, winStart - margin, winEnd + margin, meta.exceptions);
    const fires = new Set<number>();
    const rels = (meta.relative || []).map(offsetToMinutes).filter((n): n is number => n !== null);
    occs.forEach((occ) => {
        rels.forEach((min) => {
            const f = occ + min * 60000;
            if (f >= winStart && f <= winEnd) { fires.add(f); }
        });
        // Fall back to "remind at the event time" only when NO reminder was configured at all.
        if (!rels.length && !(meta.remindAt && meta.remindAt.length) && occ >= winStart && occ <= winEnd) { fires.add(occ); }
    });
    (meta.remindAt || []).forEach((t) => { if (t >= winStart && t <= winEnd) { fires.add(t); } });
    return Array.from(fires).sort((a, b) => a - b);
};

export const nextFire = (baseTs: number, meta: ReminderMeta, fromTs: number): number | null => {
    const fires = upcomingFires(baseTs, meta, fromTs, fromTs + 366 * DAY_MS);
    return fires.length ? fires[0] : null;
};

// Scan a database's rows and return every reminder that fires in [winStart, winEnd].
// `dateKey`/`reminderKey` are the canonical date column + the JSON companion column.
// Pure (no DOM/network): a scheduler feeds in rows from ctx.av.read each tick.
type SchedCell = {id: string; value: {type?: string; keyID?: string; block?: {content?: string}; date?: {content: number; isNotEmpty: boolean}; text?: {content?: string}}};
type SchedRow = {id: string; cells: SchedCell[]};
export interface DueFire { rowId: string; title: string; fireTs: number; }

export const collectDueFires = (
    rows: SchedRow[], dateKey: string, reminderKey: string, winStart: number, winEnd: number,
): DueFire[] => {
    const out: DueFire[] = [];
    rows.forEach((r) => {
        const dc = r.cells.find((c) => c.value && c.value.keyID === dateKey);
        const rc = r.cells.find((c) => c.value && c.value.keyID === reminderKey);
        const tc = r.cells.find((c) => c.value && c.value.type === "block");
        const ts = (dc && dc.value.date && dc.value.date.isNotEmpty) ? dc.value.date.content : null;
        if (ts == null || !rc) {
            return;
        }
        let meta: ReminderMeta = {};
        try { meta = JSON.parse((rc.value.text && rc.value.text.content) || "{}") as ReminderMeta; } catch { /* not JSON → no reminder */ }
        const title = (tc && tc.value.block && tc.value.block.content) || "(task)";
        upcomingFires(ts, meta, winStart, winEnd).forEach((f) => out.push({rowId: r.id, title, fireTs: f}));
    });
    return out.sort((a, b) => a.fireTs - b.fireTs);
};
