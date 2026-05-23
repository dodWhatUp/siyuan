// Ready-to-run code templates for the super-block editor. Picking one fills the
// code textarea (code/preset mode only). All target the "app" preset (full caps).
// Each is a verified, self-contained snippet that renders into ctx.el.

export interface SbTemplate { name: string; code: string; }

export const TEMPLATES: SbTemplate[] = [
    {
        name: "Interactive counter (storage)",
        code:
`// A button that increments a persisted counter (survives reloads).
const btn = document.createElement("button");
btn.className = "b3-button";
btn.textContent = "Click me";
const label = document.createElement("span");
let n = (await ctx.storage.get("clicks")) || 0;
const draw = () => { label.textContent = "  clicks: " + n; };
draw();
btn.onclick = async () => { n++; await ctx.storage.set("clicks", n); draw(); };
ctx.el.append(btn, label);`,
    },
    {
        name: "Recent blocks (SQL query)",
        code:
`// List the 10 most recently edited blocks.
const r = await ctx.siyuan.api("/api/query/sql", {
  stmt: "SELECT content FROM blocks WHERE content != '' ORDER BY updated DESC LIMIT 10"
});
ctx.el.innerHTML = "<ul>" + (r.data || []).map(b => "<li>" + (b.content || "") + "</li>").join("") + "</ul>";`,
    },
    {
        name: "Asset uploader",
        code:
`// Pick an image; it uploads to the vault assets and renders inline.
const picker = document.createElement("input");
picker.type = "file";
picker.onchange = async () => {
  const path = await ctx.assets.upload(picker.files[0]);
  ctx.el.innerHTML = '<img src="' + path + '" width="200">';
};
ctx.el.appendChild(picker);`,
    },
    {
        name: "Hotkey demo (command)",
        code:
`// Register a shortcut; press Ctrl+Shift+K to fire it.
ctx.el.textContent = "Press Ctrl+Shift+K";
ctx.command("ctrl+shift+k", () => ctx.siyuan.showMessage("hotkey fired!"));`,
    },
    {
        name: "Live clock (cron)",
        code:
`// Updates every second (background scheduled).
ctx.cron("1s", () => { ctx.el.textContent = new Date().toLocaleTimeString(); });`,
    },
    {
        name: "Open a block on click",
        code:
`// Click to focus a block (replace the id with a real block id).
const a = document.createElement("a");
a.textContent = "Open block";
a.style.cursor = "pointer";
a.onclick = () => ctx.siyuan.openBlock("20060102150405-abcdefg");
ctx.el.appendChild(a);`,
    },
];
