// Cron capability helper — parse a human "every" interval into milliseconds.
// Pure + unit-tested; the runtime's "cron" capability uses it to schedule a
// background setInterval (see runtime.ts). Min interval is clamped to 1s so a
// typo can't spin a tight loop.
//
// Accepts:
//   number      → milliseconds (clamped to >= 1000)
//   "2000"      → bare digits = milliseconds
//   "30s"       → seconds
//   "5m"        → minutes
//   "1h" / "1h30m" → hours (+ combos)
//   "2d"        → days
// Returns null for anything unrecognized.

const UNIT_MS: Record<string, number> = {d: 86400000, h: 3600000, m: 60000, s: 1000};

export const parseEvery = (spec: string | number): number | null => {
    if (typeof spec === "number") {
        return spec > 0 ? Math.max(1000, spec) : null;
    }
    const s = String(spec || "").trim().toLowerCase();
    if (!s) {
        return null;
    }
    if (/^\d+$/.test(s)) {
        return Math.max(1000, parseInt(s, 10));
    }
    const re = /(\d+)\s*(d|h|m|s)/g;
    let total = 0;
    let matched = false;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(s)) !== null) {
        total += parseInt(mm[1], 10) * UNIT_MS[mm[2]];
        matched = true;
    }
    return matched ? Math.max(1000, total) : null;
};
