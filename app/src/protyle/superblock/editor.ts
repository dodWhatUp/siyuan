// Super-block code editor (see notes/06-superblock-implementation-plan.md, P7).
//
// A minimal in-app editor. Opens a dialog with the block's current code
// (custom-sb-code) and a preset/kind picker (custom-sb-kind), lets the user edit
// both, and on Save persists via setBlockAttrs and re-renders the block through
// the runtime. Undo of code edits is not wired yet (setBlockAttrs bypasses the
// host doc's undo stack) — noted for a later step; a fuller editor (syntax
// highlight, cost meter) also comes later.

import {Dialog} from "../../dialog";
import {fetchPost} from "../../util/fetch";
import {superblockRender} from "../render/superblockRender";
import {PRESETS} from "./runtime";

const capsHint = (kind: string): string => {
    const preset = PRESETS[kind];
    return preset ? `capabilities: ${preset.caps.join(", ")}` : "unknown preset";
};

export const openSuperBlockEditor = (nodeElement: HTMLElement) => {
    const id = nodeElement.getAttribute("data-node-id") || "";
    const kind = nodeElement.getAttribute("custom-sb-kind") || "calc";
    const code = nodeElement.getAttribute("custom-sb-code") || "";

    const options = Object.keys(PRESETS)
        .map((k) => `<option value="${k}"${k === kind ? " selected" : ""}>${k}</option>`)
        .join("");

    const dialog = new Dialog({
        title: "Super Block — edit",
        width: "560px",
        content: `<div style="padding: 16px 24px">
    <div class="fn__flex" style="align-items: center; margin-bottom: 8px">
        <span class="ft__on-surface">Preset</span>
        <div class="fn__space"></div>
        <select class="b3-select" id="sbKindSelect">${options}</select>
        <div class="fn__space"></div>
        <span class="ft__smaller ft__on-surface fn__flex-1" id="sbCapsHint">${capsHint(kind)}</span>
    </div>
    <div class="ft__smaller ft__on-surface" style="margin-bottom: 8px">Code runs with <code class="fn__code">ctx</code> in scope (<code class="fn__code">ctx.el</code> = the block element).</div>
    <textarea class="b3-text-field fn__block" spellcheck="false" style="height: 240px; resize: vertical; font-family: var(--b3-font-family-code, monospace); white-space: pre; tab-size: 2"></textarea>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">Cancel</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text">Save</button>
</div>`,
    });

    const textarea = dialog.element.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = code;
    textarea.focus();

    // Keep the capability hint in sync with the chosen preset.
    const select = dialog.element.querySelector("#sbKindSelect") as HTMLSelectElement;
    const hint = dialog.element.querySelector("#sbCapsHint") as HTMLElement;
    select.addEventListener("change", () => {
        hint.textContent = capsHint(select.value);
    });

    const buttons = dialog.element.querySelectorAll(".b3-dialog__action .b3-button");
    buttons[0].addEventListener("click", () => dialog.destroy());
    buttons[1].addEventListener("click", () => {
        const newKind = select.value;
        const newCode = textarea.value;
        // Update the DOM + re-render immediately, persist the attributes in the
        // background, and close. (fetchPost's callback only fires conditionally,
        // so closing/rendering must not depend on it.)
        nodeElement.setAttribute("custom-sb-kind", newKind);
        nodeElement.setAttribute("custom-sb-code", newCode);
        nodeElement.removeAttribute("data-sb-rendered");
        superblockRender(nodeElement);
        fetchPost("/api/attr/setBlockAttrs", {id, attrs: {"custom-sb-kind": newKind, "custom-sb-code": newCode}});
        dialog.destroy();
    });
};
