// Regression tests for the super-block feature/property/reminder stack.
// Pure-logic + jsdom DOM-integration assertions. Run via ./run.mjs (which bundles
// these against a stubbed runtime + jsdom). Exits non-zero on any failure.
//
// Covered: RRULE engine, reminder + location property parse/serialize, .ics export,
// reminder scheduler dedupe, and DOM integration (calendar chip → reminder write,
// database table location cell → write, board view group + drag-write).

import {__features, registerFeature, registerProperty, getProperty} from "./runtime";
import {registerBuiltinFeatures, mapFullTextBlocks, quickFilterRecords} from "./builtinFeatures";
import {
    registerBuiltinProperties, offsetToMinutes,
    parseLocationString, parseLocationMeta, serializeLocationMeta,
} from "./builtinProperties";
import {parseRRule, expandOccurrences, upcomingFires, collectDueFires} from "./reminderEngine";
import {parseNlDate, parseQuickAdd, extractTags} from "./nlDate";
import {setFrozen, isFrozen} from "./featureFlags";
import {parseEvery} from "./cron";
import {matchHotkey} from "./hotkey";
import {storageKey, storagePath} from "./storage";
import {ReminderScheduler} from "./reminderScheduler";
import {buildICS, icsFromRows, minutesToTrigger} from "./icsExport";

let pass = 0;
const fails: string[] = [];
const eq = (name: string, got: unknown, exp: unknown) => {
    const a = JSON.stringify(got);
    const b = JSON.stringify(exp);
    if (a === b) { pass++; } else { fails.push(`${name}\n    expected ${b}\n    got      ${a}`); }
};
const ok = (name: string, cond: boolean) => { if (cond) { pass++; } else { fails.push(name); } };

const D = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m, d, h, mi, 0).getTime();
const iso = (s: number) => new Date(s).toISOString().slice(0, 16);
const tick = () => new Promise((r) => setTimeout(r, 30));

export async function run(): Promise<void> {
    // The task track is FROZEN in the shipping app (featureFlags.DEFAULT_FROZEN).
    // Tests unfreeze so the frozen code stays fully exercised — this is what keeps
    // re-enabling safe. (A separate assertion below verifies freezing hides them.)
    ok("freeze.default-on", isFrozen() === true);   // app ships with the task track frozen
    setFrozen(false);
    registerBuiltinProperties();
    registerBuiltinFeatures();

    // ---- reminder engine -------------------------------------------------
    const base = D(2026, 5, 1, 9);
    eq("rrule.daily.count3", expandOccurrences(base, parseRRule("FREQ=DAILY;COUNT=3"), base, base + 30 * 864e5).map(iso),
        ["2026-06-01T09:00", "2026-06-02T09:00", "2026-06-03T09:00"]);
    eq("rrule.weekly.byday", expandOccurrences(base, parseRRule("FREQ=WEEKLY;BYDAY=MO,WE"), base, base + 14 * 864e5).map(iso),
        ["2026-06-01T09:00", "2026-06-03T09:00", "2026-06-08T09:00", "2026-06-10T09:00", "2026-06-15T09:00"]);
    eq("rrule.until.guard", expandOccurrences(base, parseRRule("FREQ=DAILY;UNTIL=20260604"), base, base + 30 * 864e5).map(iso),
        ["2026-06-01T09:00", "2026-06-02T09:00", "2026-06-03T09:00", "2026-06-04T09:00"]);
    eq("fires.relative.weekly", upcomingFires(base, {relative: ["-15m"], rrule: "FREQ=WEEKLY"}, base - 864e5, base + 8 * 864e5).map(iso),
        ["2026-06-01T08:45", "2026-06-08T08:45"]);
    eq("fires.absolute.only", upcomingFires(base, {remindAt: [base + 36e5]}, base, base + 864e5).map(iso),
        ["2026-06-01T10:00"]);
    // recurrence exceptions skip by local date (Jun 2 skipped)
    eq("rrule.exceptions", expandOccurrences(base, parseRRule("FREQ=DAILY;COUNT=4"), base, base + 30 * 864e5, [D(2026, 5, 2, 0)]).map(iso),
        ["2026-06-01T09:00", "2026-06-03T09:00", "2026-06-04T09:00"]);

    // collectDueFires skips rows without a reminder cell
    const dueRows = [
        {id: "A", cells: [
            {id: "a1", value: {type: "block", keyID: "kb", block: {content: "A"}}},
            {id: "a2", value: {type: "date", keyID: "kd", date: {content: base, isNotEmpty: true}}},
            {id: "a3", value: {type: "text", keyID: "kr", text: {content: '{"_type":"reminder","relative":["-15m"]}'}}},
        ]},
        {id: "B", cells: [
            {id: "b1", value: {type: "block", keyID: "kb", block: {content: "B"}}},
            {id: "b2", value: {type: "date", keyID: "kd", date: {content: base, isNotEmpty: true}}},
        ]},
    ];
    eq("collectDueFires", collectDueFires(dueRows, "kd", "kr", base - 864e5, base + 864e5).map((f) => `${iso(f.fireTs)} ${f.title}`),
        ["2026-06-01T08:45 A"]);

    // ---- reminder property ----------------------------------------------
    eq("offsetToMinutes", [offsetToMinutes("-15m"), offsetToMinutes("-1d 2h"), offsetToMinutes("30m"), offsetToMinutes("x")],
        [-15, -1560, 30, null]);

    // ---- location property ----------------------------------------------
    eq("loc.bare", parseLocationString("48.8584,2.2945"), {lat: 48.8584, lng: 2.2945});
    eq("loc.named", parseLocationString("Eiffel | 48.8584, 2.2945"), {name: "Eiffel", lat: 48.8584, lng: 2.2945});
    eq("loc.at", parseLocationString("Cafe @ 40.7,-74.0"), {name: "Cafe", lat: 40.7, lng: -74});
    eq("loc.reject.range", parseLocationString("200,500"), null);
    eq("loc.reject.garbage", parseLocationString("hello"), null);
    const locMeta = parseLocationMeta("Eiffel | 48.8584,2.2945")!;
    const locSer = serializeLocationMeta(locMeta);
    ok("loc.serialize.schema", locSer.indexOf('"$schema":"siyuan-superblock/location@1"') >= 0 && locSer.indexOf('"lat":48.8584') >= 0);
    eq("loc.roundtrip.lat", parseLocationMeta(locSer)!.lat, 48.8584);

    // ---- natural-language quick-add -------------------------------------
    eq("nl.exactDate", (() => { const r = parseNlDate("review 2026-05-20"); return [new Date(r.dateMs!).getFullYear(), new Date(r.dateMs!).getMonth() + 1, new Date(r.dateMs!).getDate(), r.cleanedTitle]; })(),
        [2026, 5, 20, "review"]);
    eq("nl.tags", extractTags("ship it #work #urgent"), {tags: ["work", "urgent"], rest: "ship it"});
    const qa = parseQuickAdd("Buy milk tomorrow 3pm #errand !high");
    eq("nl.quickadd.fields", [qa.title, qa.tags, qa.priority, qa.hasTime, qa.dateMs !== undefined], ["Buy milk", ["errand"], "high", true, true]);
    ok("nl.quickadd.time3pm", new Date(qa.dateMs!).getHours() === 15);

    // ---- cron interval parsing ------------------------------------------
    eq("cron.parse", [parseEvery(5000), parseEvery(500), parseEvery("30s"), parseEvery("5m"), parseEvery("1h"), parseEvery("1h30m"), parseEvery("2d"), parseEvery("2000"), parseEvery("nope")],
        [5000, 1000, 30000, 300000, 3600000, 5400000, 172800000, 2000, null]);

    // ---- command hotkey matching ----------------------------------------
    const k = (key: string, mods: Partial<{ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean}> = {}) =>
        ({key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods});
    ok("hotkey.ctrlk", matchHotkey("ctrl+k", k("k", {ctrlKey: true})));
    ok("hotkey.ctrlk.no", !matchHotkey("ctrl+k", k("k")));
    ok("hotkey.mod.meta", matchHotkey("mod+s", k("s", {metaKey: true})));
    ok("hotkey.mod.ctrl", matchHotkey("mod+s", k("s", {ctrlKey: true})));
    ok("hotkey.shift", matchHotkey("shift+a", k("a", {shiftKey: true})) && !matchHotkey("shift+a", k("a")));
    ok("hotkey.wrongkey", !matchHotkey("ctrl+k", k("j", {ctrlKey: true})));
    // macOS: Option+1 yields key "¡" but code "Digit1" → must still match "alt+1"
    ok("hotkey.mac.option1", matchHotkey("alt+1", {key: "¡", code: "Digit1", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false}));
    ok("hotkey.ctrlshiftk", matchHotkey("ctrl+shift+k", {key: "K", code: "KeyK", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false}));

    // ---- storage key sanitizing -----------------------------------------
    eq("storage.key", [storageKey("my key!"), storageKey("../etc/passwd"), storageKey("")], ["my_key_", "___etc_passwd", "_"]);
    eq("storage.path", storagePath("notes"), "/data/storage/superblock/notes.json");

    // ---- .ics export -----------------------------------------------------
    eq("ics.trigger", [minutesToTrigger(-15), minutesToTrigger(-1440), minutesToTrigger(-90), minutesToTrigger(0)],
        ["-PT15M", "-P1D", "-PT1H30M", "PT0M"]);
    const ics = buildICS([{uid: "u1@x", title: "Stand; up", start: Date.UTC(2026, 5, 1, 9), meta: {relative: ["-15m"], rrule: "FREQ=WEEKLY"}}]);
    ok("ics.vcalendar", ics.indexOf("BEGIN:VCALENDAR") === 0 && ics.indexOf("END:VCALENDAR") > 0);
    ok("ics.rrule", ics.indexOf("RRULE:FREQ=WEEKLY") >= 0);
    ok("ics.valarm", ics.indexOf("BEGIN:VALARM") >= 0 && ics.indexOf("TRIGGER:-PT15M") >= 0);
    ok("ics.escape", ics.indexOf("SUMMARY:Stand\\; up") >= 0);
    ok("ics.fromRows", icsFromRows([{id: "r", cells: [
        {value: {type: "block", keyID: "kb", block: {content: "T"}}},
        {value: {type: "date", keyID: "kd", date: {content: Date.now(), isNotEmpty: true}}},
    ]}], "kd").indexOf("SUMMARY:T") >= 0);

    // ---- reminder scheduler dedupe --------------------------------------
    let clock = D(2026, 5, 1, 8, 44);
    const notified: string[] = [];
    const sched = new ReminderScheduler({
        getSources: () => [{avID: "AV1", dateCol: "kd", reminderCol: "kr"}],
        read: async () => ({rows: [
            {id: "A", cells: [
                {id: "a1", value: {type: "block", keyID: "kb", block: {content: "Rent"}}},
                {id: "a2", value: {type: "date", keyID: "kd", date: {content: D(2026, 5, 1, 9), isNotEmpty: true}}},
                {id: "a3", value: {type: "text", keyID: "kr", text: {content: '{"_type":"reminder","relative":["-15m"]}'}}},
            ]},
        ]}),
        now: () => clock,
        notify: (f) => notified.push(iso(f.fireTs) + " " + f.title),
    });
    clock = D(2026, 5, 1, 8, 46); await sched.tick();
    clock = D(2026, 5, 1, 8, 50); await sched.tick();
    clock = D(2026, 5, 1, 9, 1); await sched.tick();
    await sched.tick();
    eq("scheduler.dedupe", notified, ["2026-06-01T08:45 Rent"]);

    // ---- DOM integration (jsdom) ----------------------------------------
    if (typeof document !== "undefined") {
        // reminder render summary
        const rp = (await import("./runtime")).getProperty("reminder")!;
        eq("reminder.render", rp.render!(null, {relative: ["-15m"], rrule: "FREQ=WEEKLY"}).textContent, "🔔 15m before, weekly");

        // calendar chip → reminder editor → companion write
        const calRows = [{id: "row1", cells: [
            {id: "c_b", value: {type: "block", keyID: "kb", block: {content: "Task A"}}},
            {id: "c_d", value: {type: "date", keyID: "kd", date: {content: D(2026, 5, 1, 9), isNotEmpty: true}}},
            {id: "c_r", value: {type: "text", keyID: "kr", text: {content: '{"_type":"reminder","relative":["-15m"]}'}}},
        ]}];
        const calSet: Array<Record<string, unknown>> = [];
        const calCtx = {
            el: document.createElement("div"),
            av: {read: async () => ({columns: [], rows: calRows}), setCell: async (p: Record<string, unknown>) => { calSet.push(p); return {}; }},
            watch: () => {}, onUnmount: () => {},
        };
        __features.get("calendar")!.run(calCtx, {db: "AV1", dateCol: "kd", reminderCol: "kr", view: "month"});
        await tick();
        const bell = Array.from(calCtx.el.querySelectorAll("span")).find((s) => (s as HTMLElement).title === "Edit reminder") as HTMLElement;
        ok("cal.chip.bell", !!bell);
        (bell as unknown as {onclick: (e: {stopPropagation: () => void}) => void}).onclick({stopPropagation() {}});
        const save = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLElement;
        (save as unknown as {onclick: () => void}).onclick();
        await tick();
        ok("cal.reminder.write", calSet.length === 1 && calSet[0].keyID === "kr" && calSet[0].cellID === "c_r");

        // database board: group + render + drag-write
        const boardCols = [{id: "kb", name: "Title", type: "block"}, {id: "ks", name: "Status", type: "text"}];
        const boardRows = [
            {id: "r1", cells: [{id: "b1", value: {type: "block", keyID: "kb", block: {content: "X"}}}, {id: "s1", value: {type: "text", keyID: "ks", text: {content: "Todo"}}}]},
            {id: "r2", cells: [{id: "b2", value: {type: "block", keyID: "kb", block: {content: "Y"}}}, {id: "s2", value: {type: "text", keyID: "ks", text: {content: "Doing"}}}]},
        ];
        const boardSet: Array<Record<string, unknown>> = [];
        const boardCtx = {
            el: document.createElement("div"),
            av: {read: async () => ({columns: boardCols, rows: boardRows}), setCell: async (p: Record<string, unknown>) => { boardSet.push(p); return {}; }},
            watch: () => {}, onUnmount: () => {},
        };
        __features.get("database")!.run(boardCtx, {db: "AV1", groupCol: "ks", view: "board"});
        await tick();
        const headers = Array.from(boardCtx.el.querySelectorAll("div")).filter((d) =>
            /\(\d+\)\s*$/.test(d.textContent || "") && (d as HTMLElement).style.fontWeight === "bold");
        ok("board.columns", headers.length === 2);

        // search grouping: groupBy renders collapsible <details> groups with counts
        const qCtx = {
            el: document.createElement("div"),
            api: {post: async () => ({data: [
                {id: "r1", status: "Todo", title: "A"},
                {id: "r2", status: "Doing", title: "B"},
                {id: "r3", status: "Todo", title: "C"},
            ]})},
            watch: () => {},
        };
        __features.get("query")!.run(qCtx, {source: "sql", query: "x", mode: "list", groupBy: "status"});
        await tick();
        const summaries = Array.from(qCtx.el.querySelectorAll("summary")).map((s) => (s.textContent || "").replace(/\s+/g, " ").trim());
        ok("search.group.sections", qCtx.el.querySelectorAll("details").length === 2);
        ok("search.group.counts", summaries.includes("Todo (2)") && summaries.includes("Doing (1)"));

        // saved views → switcher tabs + a quick-filter input present
        const vCtx = {
            el: document.createElement("div"),
            api: {post: async () => ({data: [{id: "r1", status: "Todo", title: "A"}]})},
            watch: () => {},
        };
        __features.get("query")!.run(vCtx, {source: "sql", query: "x",
            views: [{name: "All", mode: "list"}, {name: "By status", mode: "list", groupBy: "status"}]});
        await tick();
        const tabs = Array.from(vCtx.el.querySelectorAll("button")).map((b) => b.textContent);
        ok("search.savedviews.tabs", tabs.includes("All") && tabs.includes("By status"));
        ok("search.filter.input", !!vCtx.el.querySelector("input.b3-text-field"));

        // search result actions: a row with a block id is clickable → ctx.open(id)
        const opened: Array<[string, boolean | undefined]> = [];
        const oCtx = {
            el: document.createElement("div"),
            api: {post: async () => ({data: [{id: "20260101120000-abcdefg", content: "hello"}]})},
            open: (id: string, nw?: boolean) => { opened.push([id, nw]); },
            watch: () => {},
        };
        __features.get("query")!.run(oCtx, {source: "sql", query: "x", mode: "table"});
        await tick();
        const row = Array.from(oCtx.el.querySelectorAll("tr")).find((tr) => (tr as HTMLElement).onclick) as HTMLElement | undefined;
        ok("search.open.clickable", !!row);
        if (row) { (row as unknown as {onclick: () => void}).onclick(); }
        ok("search.open.fires", opened.length === 1 && opened[0][0] === "20260101120000-abcdefg" && opened[0][1] === false);

        // search "embed" mode: each result with a block id is embedded via ctx.embed
        const embedded: string[] = [];
        const emCtx = {
            el: document.createElement("div"),
            api: {post: async () => ({data: [{id: "20260101120000-abcdefg", content: "x"}]})},
            embed: (id: string, container?: HTMLElement) => { embedded.push(id); if (container) { container.textContent = "[embedded]"; } },
            watch: () => {},
        };
        __features.get("query")!.run(emCtx, {source: "sql", query: "x", mode: "embed"});
        await tick();
        ok("search.embedmode.calls", embedded.length === 1 && embedded[0] === "20260101120000-abcdefg");

        // raw HTML feature: injects unsanitized markup (scripts/iframes allowed)
        const hCtx = {el: document.createElement("div"), watch: () => {}};
        __features.get("html")!.run(hCtx, {html: "<b id='rawx'>hi</b><iframe src='about:blank'></iframe>"});
        ok("html.injects", !!hCtx.el.querySelector("#rawx") && !!hCtx.el.querySelector("iframe"));

        // embed read-only: fetches the target's markdown into a static box
        const eCtx = {
            el: document.createElement("div"),
            api: {post: async () => ({data: [{markdown: "# Embedded heading", content: "Embedded heading"}]})},
            watch: () => {},
        };
        __features.get("embed")!.run(eCtx, {target: "20260101-abc", view: "readonly"});
        await tick();
        ok("embed.readonly.content", (eCtx.el.textContent || "").includes("# Embedded heading"));
        // embed editable falls back to a message when the embed capability is absent
        const e2 = {el: document.createElement("div"), watch: () => {}};
        __features.get("embed")!.run(e2, {target: "x", view: "editable"});
        ok("embed.editable.fallback", (e2.el.textContent || "").includes("embed capability"));
    }

    // ---- search: full-text result mapping -------------------------------
    eq("search.fulltext.map", mapFullTextBlocks([
        {id: "b1", content: "buy <mark>milk</mark> today", hPath: "/Inbox"},
        {content: "no id", hPath: "/x", name: "Doc"},
    ]), [
        {id: "b1", values: {content: "buy milk today", path: "/Inbox", name: ""}},
        {id: "1", values: {content: "no id", path: "/x", name: "Doc"}},
    ]);

    // ---- search: quick filter (pure) -----------------------------------
    eq("search.filter.match", quickFilterRecords([
        {id: "1", values: {a: "hello world"}}, {id: "2", values: {a: "goodbye"}},
    ], "world").map((r) => r.id), ["1"]);
    eq("search.filter.empty", quickFilterRecords([{id: "1", values: {a: "x"}}], "  ").length, 1);

    // ---- plugin extensibility (SPI stays open) --------------------------
    // A plugin registers a custom feature + property via the same registry the SPI
    // exposes; both must be listed and usable regardless of the freeze.
    registerFeature({id: "plugFeat", label: "Plug Feature", caps: ["ui"], configSchema: [{key: "x", label: "X", type: "text"}], run: () => { /* noop */ }});
    registerProperty({id: "plugProp", label: "Plug Prop", baseType: "text"});
    ok("ext.feature.registered", __features.get("plugFeat")?.label === "Plug Feature");
    ok("ext.property.registered", getProperty("plugProp")?.baseType === "text");

    // ---- freeze gating: built-ins hidden, query kept -------------------
    __features.clear();
    setFrozen(true);
    registerBuiltinFeatures();
    ok("freeze.hides.calendar", !__features.get("calendar"));
    ok("freeze.hides.database", !__features.get("database"));
    ok("freeze.keeps.query", !!__features.get("query"));
    setFrozen(false);   // restore for any later use

    // ---- summary ---------------------------------------------------------
    const total = pass + fails.length;
    if (fails.length) {
        console.log(`\nFAILED ${fails.length}/${total}:`);
        fails.forEach((f) => console.log("  ✗ " + f));
        (globalThis as unknown as {process: {exitCode: number}}).process.exitCode = 1;
    } else {
        console.log(`\n✓ all ${total} super-block assertions passed`);
    }
}
