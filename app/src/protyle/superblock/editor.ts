// Super-block code editor (see notes/06-superblock-implementation-plan.md, P7).
//
// A minimal in-app editor. Opens a dialog with the block's current code
// (custom-sb-code) and a preset/kind picker (custom-sb-kind), lets the user edit
// both, and on Save persists via setBlockAttrs and re-renders the block through
// the runtime. The textarea is layered over a highlight.js-painted <pre> for
// syntax highlighting (the textarea keeps native editing/caret/undo; the <pre>
// just paints colors behind it). Undo of code edits is not wired into the host
// doc's undo stack yet (setBlockAttrs bypasses it).

import {Dialog} from "../../dialog";
import {fetchPost} from "../../util/fetch";
import {superblockRender} from "../render/superblockRender";
import {getPreset, listPresets, getFeature, listFeatures, SuperBlockFeature} from "./runtime";
import {addScript} from "../util/addScript";
import {setCodeTheme} from "../render/util";
import {Constants} from "../../constants";

const capsHint = (kind: string): string => {
    const preset = getPreset(kind);
    return preset ? `capabilities: ${preset.caps.join(", ")}` : "unknown preset";
};

// Build a no-code settings form from a feature's configSchema (notes/14 L3). Each
// field becomes a labelled control; `data-key`/`data-ftype` let readConfigForm
// collect typed values back out on Save. Smart pickers (av-database/av-column)
// fall back to text inputs for now.
const buildConfigForm = (feature: SuperBlockFeature, current: Record<string, unknown>): HTMLElement => {
    const form = document.createElement("div");
    const schema = feature.configSchema || [];
    if (schema.length === 0) {
        form.className = "ft__smaller ft__on-surface";
        form.textContent = "This feature has no options.";
        return form;
    }
    schema.forEach((field) => {
        const row = document.createElement("div");
        row.className = "fn__flex";
        row.style.cssText = "align-items:center;margin:6px 0";
        const label = document.createElement("div");
        label.textContent = field.label;
        label.style.cssText = "width:130px;flex-shrink:0";
        row.appendChild(label);
        const val = current[field.key];
        let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (field.type === "select") {
            const sel = document.createElement("select");
            sel.className = "b3-select fn__flex-1";
            field.options.forEach((o) => {
                const op = document.createElement("option");
                op.value = o.value;
                op.textContent = o.label;
                if (o.value === val) {
                    op.selected = true;
                }
                sel.appendChild(op);
            });
            input = sel;
        } else if (field.type === "checkbox") {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "b3-switch";
            cb.checked = !!val;
            input = cb;
        } else if (field.type === "code") {
            const ta = document.createElement("textarea");
            ta.className = "b3-text-field fn__flex-1";
            ta.style.cssText = "height:72px;font-family:var(--b3-font-family-code,monospace);white-space:pre";
            ta.value = val != null ? String(val) : "";
            input = ta;
        } else {
            const inp = document.createElement("input");
            inp.className = "b3-text-field fn__flex-1";
            if (field.type === "number") {
                inp.type = "number";
            }
            inp.value = val != null ? String(val) : "";
            input = inp;
        }
        input.setAttribute("data-key", field.key);
        input.setAttribute("data-ftype", field.type);
        row.appendChild(input);
        form.appendChild(row);
    });
    return form;
};

const readConfigForm = (form: HTMLElement): Record<string, unknown> => {
    const cfg: Record<string, unknown> = {};
    form.querySelectorAll("[data-key]").forEach((el) => {
        const key = el.getAttribute("data-key") as string;
        const ft = el.getAttribute("data-ftype");
        if (ft === "checkbox") {
            cfg[key] = (el as HTMLInputElement).checked;
        } else if (ft === "number") {
            const v = (el as HTMLInputElement).value;
            cfg[key] = v === "" ? null : Number(v);
        } else {
            cfg[key] = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
        }
    });
    return cfg;
};

// Style props shared by the textarea and the highlight <pre> so they overlap
// pixel-for-pixel. Any divergence (padding, line-height, font) would misalign
// the painted colors from the typed text.
const SHARED_STYLE: Partial<CSSStyleDeclaration> = {
    margin: "0",
    border: "0",
    padding: "8px",
    width: "100%",
    height: "240px",
    boxSizing: "border-box",
    fontFamily: "var(--b3-font-family-code, monospace)",
    fontSize: "85%",
    lineHeight: "1.5",
    whiteSpace: "pre",
    tabSize: "2",
    overflow: "auto",
};

// Layer a highlight.js <pre> behind `textarea`, scroll-synced. Returns a render()
// to re-highlight. Degrades gracefully: if hljs fails to load, the textarea still
// works, just without colors.
const attachHighlight = (textarea: HTMLTextAreaElement) => {
    const parent = textarea.parentElement as HTMLElement;
    const wrap = document.createElement("div");
    wrap.className = "b3-text-field fn__block";
    wrap.style.position = "relative";
    wrap.style.padding = "0";
    wrap.style.resize = "vertical";
    wrap.style.overflow = "hidden";
    parent.insertBefore(wrap, textarea);

    const pre = document.createElement("pre");
    pre.className = "hljs";
    pre.setAttribute("aria-hidden", "true");
    const codeEl = document.createElement("code");
    pre.appendChild(codeEl);

    Object.assign(pre.style, SHARED_STYLE);
    pre.style.position = "absolute";
    pre.style.inset = "0";
    pre.style.pointerEvents = "none";
    pre.style.background = "transparent";

    wrap.appendChild(pre);
    wrap.appendChild(textarea);

    // The textarea sits on top with invisible text but a visible caret, so the
    // colors from the <pre> show through.
    Object.assign(textarea.style, SHARED_STYLE);
    textarea.style.position = "relative";
    textarea.style.background = "transparent";
    textarea.style.color = "transparent";
    textarea.style.caretColor = "var(--b3-theme-on-background)";
    textarea.classList.remove("b3-text-field");

    const render = () => {
        if (!window.hljs) {
            return;
        }
        // Trailing newline needs a filler char or the last line height is lost.
        const value = textarea.value.endsWith("\n") ? textarea.value + " " : textarea.value;
        try {
            codeEl.innerHTML = window.hljs.highlight(value, {language: "javascript"}).value;
        } catch (e) {
            codeEl.textContent = value;
        }
        pre.scrollTop = textarea.scrollTop;
        pre.scrollLeft = textarea.scrollLeft;
    };

    textarea.addEventListener("input", render);
    textarea.addEventListener("scroll", () => {
        pre.scrollTop = textarea.scrollTop;
        pre.scrollLeft = textarea.scrollLeft;
    });
    // Tab inserts two spaces instead of leaving the field.
    textarea.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") {
            return;
        }
        event.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.slice(0, start) + "  " + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        render();
    });

    // Load hljs (+ theme) then do the first paint; textarea is usable meanwhile.
    setCodeTheme(Constants.PROTYLE_CDN);
    addScript(`${Constants.PROTYLE_CDN}/js/highlight.js/highlight.min.js?v=11.11.1`, "protyleHljsScript").then(render);
    render();
};

export const openSuperBlockEditor = (nodeElement: HTMLElement) => {
    const id = nodeElement.getAttribute("data-node-id") || "";
    const kind = nodeElement.getAttribute("custom-sb-kind") || "calc";
    const code = nodeElement.getAttribute("custom-sb-code") || "";
    const currentConfig = (): Record<string, unknown> => {
        try {
            return JSON.parse(nodeElement.getAttribute("custom-sb-config") || "{}");
        } catch {
            return {};
        }
    };

    // The "type" picker lists presets (raw-code) AND features (config-driven).
    const kinds = listPresets();
    listFeatures().forEach((f) => {
        if (!kinds.includes(f.id)) {
            kinds.push(f.id);
        }
    });
    const options = kinds
        .map((k) => `<option value="${k}"${k === kind ? " selected" : ""}>${k}</option>`)
        .join("");

    const dialog = new Dialog({
        title: "Super Block — edit",
        width: "560px",
        content: `<div style="padding: 16px 24px">
    <div class="fn__flex" style="align-items: center; margin-bottom: 8px">
        <span class="ft__on-surface">Type</span>
        <div class="fn__space"></div>
        <select class="b3-select" id="sbKindSelect">${options}</select>
        <div class="fn__space"></div>
        <span class="ft__smaller ft__on-surface fn__flex-1" id="sbCapsHint">${capsHint(kind)}</span>
    </div>
    <div id="sbConfigForm" style="display:none"></div>
    <div id="sbCodeHint" class="ft__smaller ft__on-surface" style="margin-bottom: 8px">Code runs with <code class="fn__code">ctx</code> in scope (<code class="fn__code">ctx.el</code> = the block element).</div>
    <textarea spellcheck="false"></textarea>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">Cancel</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text">Save</button>
</div>`,
    });

    const textarea = dialog.element.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = code;
    attachHighlight(textarea);
    const codeWrap = textarea.parentElement as HTMLElement; // the wrap attachHighlight created
    const configForm = dialog.element.querySelector("#sbConfigForm") as HTMLElement;
    const codeHint = dialog.element.querySelector("#sbCodeHint") as HTMLElement;
    const select = dialog.element.querySelector("#sbKindSelect") as HTMLSelectElement;
    const hint = dialog.element.querySelector("#sbCapsHint") as HTMLElement;

    // Feature kind → config form (no-code); preset kind → code editor.
    const toggleMode = (k: string) => {
        const feature = getFeature(k);
        if (feature) {
            configForm.innerHTML = "";
            configForm.appendChild(buildConfigForm(feature, {...(feature.defaultConfig || {}), ...currentConfig()}));
            configForm.style.display = "";
            codeWrap.style.display = "none";
            codeHint.style.display = "none";
            hint.textContent = `feature · ${feature.caps.join(", ")}`;
        } else {
            configForm.style.display = "none";
            codeWrap.style.display = "";
            codeHint.style.display = "";
            hint.textContent = capsHint(k);
        }
    };
    toggleMode(kind);
    select.addEventListener("change", () => toggleMode(select.value));

    const buttons = dialog.element.querySelectorAll(".b3-dialog__action .b3-button");
    buttons[0].addEventListener("click", () => dialog.destroy());
    buttons[1].addEventListener("click", () => {
        const newKind = select.value;
        const feature = getFeature(newKind);
        const attrs: Record<string, string> = {"custom-sb-kind": newKind};
        nodeElement.setAttribute("custom-sb-kind", newKind);
        if (feature) {
            const json = JSON.stringify(readConfigForm(configForm));
            nodeElement.setAttribute("custom-sb-config", json);
            attrs["custom-sb-config"] = json;
        } else {
            const newCode = textarea.value;
            nodeElement.setAttribute("custom-sb-code", newCode);
            attrs["custom-sb-code"] = newCode;
        }
        // Update DOM + re-render immediately, persist in the background, close.
        nodeElement.removeAttribute("data-sb-rendered");
        superblockRender(nodeElement);
        fetchPost("/api/attr/setBlockAttrs", {id, attrs});
        dialog.destroy();
    });
};
