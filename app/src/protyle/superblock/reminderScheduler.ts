// Reminder scheduler (notes/16) — polls reminder-bearing databases and fires a
// browser Notification when a reminder's time arrives. The core (tick + dedupe)
// is injectable (now/read/notify) so it can be unit-tested without a browser or
// kernel. Mirrors siyuan-plugin-tasks/src/reminder/scheduler.ts, but reuses the
// shared reminderEngine (collectDueFires) instead of its own parsing.

import {collectDueFires, DueFire} from "./reminderEngine";

export interface ReminderSource { avID: string; dateCol: string; reminderCol: string; }

export interface SchedulerOpts {
    getSources: () => ReminderSource[];                 // which DBs to scan
    read: (avID: string) => Promise<{rows: unknown[]}>; // usually ctx.av.read
    pollMs?: number;                                    // default 30s
    now?: () => number;                                 // injectable clock (tests)
    notify?: (f: DueFire) => void;                      // injectable sink (tests); default = Notification
}

export class ReminderScheduler {
    private timer: ReturnType<typeof setInterval> | null = null;
    private fired = new Set<string>();
    private lastTick: number;

    constructor(private opts: SchedulerOpts) {
        this.lastTick = (opts.now || Date.now)();
    }

    async ensurePermission(): Promise<string> {
        if (typeof Notification === "undefined") {
            return "denied";
        }
        if (Notification.permission === "default") {
            try { return await Notification.requestPermission(); } catch { return "denied"; }
        }
        return Notification.permission;
    }

    start() {
        if (this.timer) {
            return;
        }
        this.tick().catch(() => { /* ignore tick errors */ });
        this.timer = setInterval(() => { this.tick().catch(() => { /* ignore */ }); }, this.opts.pollMs || 30000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // One poll: fire any reminder whose time falls in (lastTick, now].
    async tick(): Promise<void> {
        const now = (this.opts.now || Date.now)();
        const winStart = this.lastTick;
        this.lastTick = now;
        for (const src of this.opts.getSources()) {
            if (!src.avID || !src.dateCol || !src.reminderCol) {
                continue;
            }
            let view: {rows: unknown[]};
            try { view = await this.opts.read(src.avID); } catch { continue; }
            const due = collectDueFires(view.rows as Parameters<typeof collectDueFires>[0], src.dateCol, src.reminderCol, winStart, now);
            for (const f of due) {
                const key = `${src.avID}:${f.rowId}:${f.fireTs}`;
                if (this.fired.has(key)) {
                    continue;
                }
                this.fired.add(key);
                this.fire(f);
            }
        }
        if (this.fired.size > 5000) {
            this.fired = new Set(Array.from(this.fired).slice(-2000));
        }
    }

    private fire(f: DueFire) {
        if (this.opts.notify) {
            this.opts.notify(f);
            return;
        }
        try {
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                new Notification("⏰ " + f.title);
            }
        } catch { /* notification unavailable */ }
    }
}
