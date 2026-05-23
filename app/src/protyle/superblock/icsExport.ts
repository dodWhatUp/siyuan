// iCalendar (.ics) export (notes/16, north star = task → calendar sync-out).
// Turns tasks (canonical date + reminder companion JSON) into VEVENTs with RRULE
// (repeat) and VALARM (relative + absolute reminders). Pure string building — no
// DOM/network — so it is unit-testable. Reuses the shared reminder model.

import {ReminderMeta, offsetToMinutes} from "./builtinProperties";

export interface IcsEvent { uid: string; title: string; start: number; end?: number; meta?: ReminderMeta; }

const pad = (n: number) => String(n).padStart(2, "0");

// Local epoch ms → UTC iCal timestamp (YYYYMMDDTHHMMSSZ).
const fmtUTC = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

const esc = (s: string): string => s.replace(/([\\;,])/g, "\\$1").replace(/\n/g, "\\n");

// Signed minutes → iCal TRIGGER duration. Negative = before start (e.g. -PT15M).
export const minutesToTrigger = (min: number): string => {
    const sign = min < 0 ? "-" : "";
    let a = Math.abs(min);
    const d = Math.floor(a / 1440); a -= d * 1440;
    const h = Math.floor(a / 60); a -= h * 60;
    const m = a;
    let dur = "P";
    if (d) { dur += d + "D"; }
    if (h || m || !d) {
        dur += "T";
        if (h) { dur += h + "H"; }
        if (m || !h) { dur += m + "M"; }
    }
    return sign + dur;
};

export const buildICS = (events: IcsEvent[], calName = "SiYuan Tasks"): string => {
    const lines: string[] = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SiYuan//super-block//EN",
        "CALSCALE:GREGORIAN", "X-WR-CALNAME:" + esc(calName),
    ];
    const stamp = fmtUTC(Date.now());
    events.forEach((ev) => {
        const meta = ev.meta || {};
        lines.push("BEGIN:VEVENT");
        lines.push("UID:" + ev.uid);
        lines.push("DTSTAMP:" + stamp);
        lines.push("DTSTART:" + fmtUTC(ev.start));
        lines.push("DTEND:" + fmtUTC(ev.end ?? ev.start + 3600000));
        lines.push("SUMMARY:" + esc(ev.title));
        if (meta.rrule) { lines.push("RRULE:" + meta.rrule); }
        if (meta.exceptions && meta.exceptions.length) { lines.push("EXDATE:" + meta.exceptions.map(fmtUTC).join(",")); }
        (meta.relative || []).forEach((off) => {
            const min = offsetToMinutes(off);
            if (min === null) { return; }
            lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(ev.title), "TRIGGER:" + minutesToTrigger(min), "END:VALARM");
        });
        (meta.remindAt || []).forEach((t) => {
            lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(ev.title), "TRIGGER;VALUE=DATE-TIME:" + fmtUTC(t), "END:VALARM");
        });
        lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
};

// Convenience: build .ics straight from a database's rows (same shape as the
// scheduler/calendar use). Rows without a date are skipped.
type IcsCell = {value: {type?: string; keyID?: string; block?: {content?: string}; date?: {content: number; isNotEmpty: boolean}; text?: {content?: string}}};
type IcsRow = {id: string; cells: IcsCell[]};

export const icsFromRows = (rows: IcsRow[], dateKey: string, reminderKey?: string, calName?: string): string => {
    const events: IcsEvent[] = [];
    rows.forEach((r) => {
        const dc = r.cells.find((c) => c.value && c.value.keyID === dateKey);
        const tc = r.cells.find((c) => c.value && c.value.type === "block");
        const ts = (dc && dc.value.date && dc.value.date.isNotEmpty) ? dc.value.date.content : null;
        if (ts == null) { return; }
        let meta: ReminderMeta = {};
        if (reminderKey) {
            const rc = r.cells.find((c) => c.value && c.value.keyID === reminderKey);
            try { meta = JSON.parse((rc && rc.value.text && rc.value.text.content) || "{}") as ReminderMeta; } catch { /* none */ }
        }
        events.push({uid: r.id + "@siyuan", title: (tc && tc.value.block && tc.value.block.content) || "(task)", start: ts, meta});
    });
    return buildICS(events, calName);
};
