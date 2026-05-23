// Natural-language quick-add parsing (ported from the task plugin, my-plugin/
// src/util/nlDate.ts). Pure functions: turn "Buy milk tomorrow 3pm #errand !high"
// into {dateMs, hasTime, title, tags, priority}. Used by the calendar/database
// quick-add bar. No deps, no DOM.

export interface NlParseResult {
    dateMs?: number;
    hasTime: boolean;
    cleanedTitle: string;
}

const WEEKDAYS: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
};

const stripMatch = (input: string, match: RegExpExecArray): string => {
    const before = input.slice(0, match.index).replace(/\s+$/, "");
    const after = input.slice(match.index + match[0].length).replace(/^\s+/, "");
    return (before + (before && after ? " " : "") + after).trim();
};

const upcomingWeekday = (weekdayNum: number, forceNextWeek: boolean): Date => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    let diff = (weekdayNum - d.getDay() + 7) % 7;
    if (diff === 0) { diff = 7; }
    if (forceNextWeek && diff < 7) { diff += 7; }
    d.setDate(d.getDate() + diff);
    return d;
};

const applyTimePhrase = (input: string, baseDate: Date): {input: string; hasTime: boolean} => {
    const named: Array<[RegExp, [number, number]]> = [
        [/\b(noon|midday)\b/i, [12, 0]], [/\b(midnight)\b/i, [0, 0]], [/\b(morning)\b/i, [9, 0]],
        [/\b(afternoon)\b/i, [14, 0]], [/\b(evening)\b/i, [18, 0]], [/\b(tonight|night)\b/i, [20, 0]],
    ];
    for (const [re, [h, m]] of named) {
        const mm = re.exec(input);
        if (mm) { baseDate.setHours(h, m, 0, 0); return {input: stripMatch(input, mm), hasTime: true}; }
    }
    const re = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
    const mm = re.exec(input);
    if (mm) {
        let h = parseInt(mm[1], 10);
        const m = mm[2] ? parseInt(mm[2], 10) : 0;
        const suffix = mm[3]?.toLowerCase();
        if (!suffix && !mm[2] && (h > 23 || (mm.index > 0 && /[a-z]/i.test(input[mm.index - 1] || "")))) {
            return {input, hasTime: false};
        }
        if (suffix === "pm" && h < 12) { h += 12; }
        if (suffix === "am" && h === 12) { h = 0; }
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
            baseDate.setHours(h, m, 0, 0);
            return {input: stripMatch(input, mm), hasTime: true};
        }
    }
    return {input, hasTime: false};
};

export const parseNlDate = (raw: string): NlParseResult => {
    let s = raw;
    let baseDate: Date | null = null;
    let m: RegExpExecArray | null = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
    if (m) { baseDate = new Date(+m[1], +m[2] - 1, +m[3]); s = stripMatch(s, m); }
    if (!baseDate) {
        m = /\b(today|tomorrow|tmrw|tomo|yesterday)\b/i.exec(s);
        if (m) {
            const d = new Date(); d.setHours(0, 0, 0, 0);
            const key = m[1].toLowerCase();
            if (/tomo|tmrw|tomorrow/.test(key)) { d.setDate(d.getDate() + 1); }
            else if (key === "yesterday") { d.setDate(d.getDate() - 1); }
            baseDate = d; s = stripMatch(s, m);
        }
    }
    if (!baseDate) {
        m = /\bin\s+(\d+)\s*(min|minutes?|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)\b/i.exec(s);
        if (m) {
            const n = parseInt(m[1], 10);
            const unit = m[2].toLowerCase();
            const d = new Date();
            if (unit.startsWith("min")) { d.setMinutes(d.getMinutes() + n); }
            else if (/^h|^hr|^hour/.test(unit)) { d.setHours(d.getHours() + n); }
            else if (unit.startsWith("d") || unit.startsWith("day")) { d.setDate(d.getDate() + n); }
            else { d.setDate(d.getDate() + n * 7); }
            baseDate = d; s = stripMatch(s, m);
        }
    }
    if (!baseDate) {
        m = /\b(next\s+)?(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/i.exec(s);
        if (m) {
            const wd = WEEKDAYS[m[2].toLowerCase()];
            if (wd !== undefined) { baseDate = upcomingWeekday(wd, !!m[1]); s = stripMatch(s, m); }
        }
    }
    let hasTime = false;
    if (baseDate) {
        const res = applyTimePhrase(s, baseDate); s = res.input; hasTime = res.hasTime;
    } else {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const res = applyTimePhrase(s, today);
        if (res.hasTime) { baseDate = today; hasTime = true; s = res.input; }
    }
    return {dateMs: baseDate?.getTime(), hasTime, cleanedTitle: s.replace(/\s+/g, " ").trim()};
};

export const extractTags = (raw: string): {tags: string[]; rest: string} => {
    const tags: string[] = [];
    const rest = raw.replace(/(^|\s)#([A-Za-z0-9_\-]+)/g, (_, lead, tag) => { tags.push(tag); return lead; })
        .replace(/\s+/g, " ").trim();
    return {tags, rest};
};

export const extractPriority = (raw: string): {priority?: string; rest: string} => {
    const m = /(^|\s)!([A-Za-z]+|\d+)\b/.exec(raw);
    if (!m) { return {rest: raw}; }
    const rest = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    return {priority: m[2].toLowerCase(), rest};
};

// Full quick-add parse: title + date + tags + priority in one call.
export interface QuickAdd { title: string; dateMs?: number; hasTime: boolean; tags: string[]; priority?: string; }
export const parseQuickAdd = (raw: string): QuickAdd => {
    const p = extractPriority(raw);
    const t = extractTags(p.rest);
    const d = parseNlDate(t.rest);
    return {title: d.cleanedTitle, dateMs: d.dateMs, hasTime: d.hasTime, tags: t.tags, priority: p.priority};
};
