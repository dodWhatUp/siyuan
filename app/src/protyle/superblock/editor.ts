// Super-block code editor (see notes/06-superblock-implementation-plan.md, P7).
//
// Step 3 scope: a minimal in-app editor. Opens a dialog with the block's current
// code (custom-sb-code), lets the user edit it, and on Save persists via
// setBlockAttrs and re-renders the block through the runtime. Undo of code edits
// is not wired yet (setBlockAttrs bypasses the host doc's undo stack) — noted for
// a later step; a fuller editor (syntax highlight, capability/preset picker,
// cost meter) also comes later.

import {Dialog} from "../../dialog";
import {fetchPost} from "../../util/fetch";
import {superblockRender} from "../render/superblockRender";

export const openSuperBlockEditor = (nodeElement: HTMLElement) => {
    const id = nodeElement.getAttribute("data-node-id") || "";
    const kind = nodeElement.getAttribute("custom-sb-kind") || "calc";
    const code = nodeElement.getAttribute("custom-sb-code") || "";

    const dialog = new Dialog({
        title: `Super Block — edit code (${kind})`,
        width: "560px",
        content: `<div style="padding: 16px 24px">
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

    const buttons = dialog.element.querySelectorAll(".b3-dialog__action .b3-button");
    buttons[0].addEventListener("click", () => dialog.destroy());
    buttons[1].addEventListener("click", () => {
        const newCode = textarea.value;
        // Update the DOM + re-render immediately, persist the attribute in the
        // background, and close. (fetchPost's callback only fires conditionally,
        // so closing/rendering must not depend on it.)
        nodeElement.setAttribute("custom-sb-code", newCode);
        nodeElement.removeAttribute("data-sb-rendered");
        superblockRender(nodeElement);
        fetchPost("/api/attr/setBlockAttrs", {id, attrs: {"custom-sb-code": newCode}});
        dialog.destroy();
    });
};
