# Super-block tests

Regression tests for the super-block feature/property/reminder stack. They bundle
the modules under test against a **stub runtime** (no heavy fork deps) and a jsdom
DOM, so they run standalone — no SiYuan kernel, no full app build.

## Run

```
node app/src/protyle/superblock/__tests__/run.mjs
```

Exits non-zero on any failure (CI-friendly). First run fetches `esbuild` + `jsdom`
into a temp dir (needs network once); afterwards it's offline.

## What's covered (`superblock.test.ts`)

- **reminderEngine** — RRULE parse + occurrence expansion (daily/weekly-BYDAY/monthly), `COUNT`/`UNTIL` guards, `upcomingFires` (relative + absolute), `collectDueFires` (skips rows with no reminder).
- **builtinProperties** — reminder offset parsing; location string formats (`lat,lng`, `name | lat,lng`, `name @ lat,lng`, range/garbage rejection) + JSON round-trip with self-describing `$schema`.
- **icsExport** — `TRIGGER` durations, VCALENDAR/VEVENT/RRULE/VALARM structure, `;` escaping, `icsFromRows`.
- **reminderScheduler** — tick window + dedupe across repeated ticks (injected clock + notify sink).
- **DOM integration** (jsdom) — calendar chip renders a reminder bell and the editor write produces the correct companion `setCell` payload; board view groups rows into the right number of columns.

## When you change the stack

Add/extend an assertion here in the same commit. If you add a new feature module,
add it to the `MODULES` list in `run.mjs` so it gets bundled.
