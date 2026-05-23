// Self-contained test runner for the super-block stack. Bundles the modules under
// test against a STUB runtime (so it needs none of the heavy fork deps), sets up a
// jsdom DOM, runs superblock.test.ts, and exits non-zero on failure.
//
// Usage:  node app/src/protyle/superblock/__tests__/run.mjs
// Requires network on first run only (fetches esbuild + jsdom via npx/npm).

import {execFileSync} from "node:child_process";
import {mkdtempSync, cpSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..");
const work = mkdtempSync(path.join(tmpdir(), "sbtest-"));
const MODULES = ["builtinFeatures", "builtinProperties", "viewEngine", "reminderEngine", "reminderScheduler", "icsExport"];

for (const m of MODULES) {
    cpSync(path.join(src, m + ".ts"), path.join(work, m + ".ts"));
}
// Stub runtime: just the registries the modules import (no fork deps, no DOM).
writeFileSync(path.join(work, "runtime.ts"),
    "export type SuperBlockCtx=any;const props=new Map();export const __features=new Map();" +
    "export const registerProperty=(d)=>props.set(d.id,d);export const getProperty=(id)=>props.get(id);" +
    "export const registerFeature=(d)=>__features.set(d.id,d);\n");
cpSync(path.join(here, "superblock.test.ts"), path.join(work, "superblock.test.ts"));

console.log("bundling (esbuild)…");
execFileSync("npx", ["--yes", "esbuild", "superblock.test.ts", "--bundle", "--platform=node", "--format=cjs", "--outfile=test.cjs"],
    {cwd: work, stdio: "inherit"});

const req = createRequire(path.join(work, "noop.js"));
let JSDOM;
try {
    ({JSDOM} = req("jsdom"));
} catch {
    console.log("installing jsdom (one-time)…");
    execFileSync("npm", ["i", "jsdom", "--no-save", "--no-audit", "--no-fund"], {cwd: work, stdio: "inherit"});
    ({JSDOM} = req("jsdom"));
}

const dom = new JSDOM("<!DOCTYPE html><body></body>", {pretendToBeVisual: true});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.Blob = dom.window.Blob;
globalThis.URL = dom.window.URL;

const mod = req(path.join(work, "test.cjs"));
await mod.run();
