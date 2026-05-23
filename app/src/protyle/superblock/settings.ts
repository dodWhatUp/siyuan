// Super-block settings panel (see notes/06-superblock-implementation-plan.md, step 5).
//
// A minimal dialog over the safety policy in policy.ts: a global kill-switch plus
// per-capability global disables for the risky caps (api / network / persist).
// On save it writes the policy and re-renders every super-block currently in the
// DOM so the change takes effect immediately (no reload needed).

import {Dialog} from "../../dialog";
import {getPolicy, setPolicy, SuperBlockPolicy} from "./policy";
import {superblockRender, SB_MARKER} from "../render/superblockRender";
import type {Capability} from "./runtime";

// The capabilities exposed as global toggles. compute/ui are intentionally not
// listed — disabling them just neuters blocks; the meaningful controls are these.
const TOGGLEABLE: Capability[] = ["api", "network", "persist"];

const row = (id: string, label: string, hint: string, checked: boolean) => `<label class="fn__flex" style="padding: 6px 0; align-items: center">
    <input type="checkbox" id="${id}" class="b3-switch fn__flex-center"${checked ? " checked" : ""}>
    <div class="fn__space"></div>
    <div class="fn__flex-1">
        <div>${label}</div>
        <div class="ft__smaller ft__on-surface">${hint}</div>
    </div>
</label>`;

const reRenderAll = () => {
    document.querySelectorAll(`[data-type="NodeHTMLBlock"][${SB_MARKER}]`).forEach((block) => {
        block.removeAttribute("data-sb-rendered");
    });
    superblockRender(document.body);
};

export const openSuperBlockSettings = () => {
    const policy = getPolicy();

    const dialog = new Dialog({
        title: "Super Block — settings",
        width: "520px",
        content: `<div style="padding: 16px 24px">
    ${row("sbKill", "Disable all super-blocks", "Global kill-switch. No super-block code runs.", policy.kill)}
    <div class="b3-dialog__action" style="padding: 8px 0 0; border: 0"></div>
    <div class="ft__smaller ft__on-surface" style="margin: 8px 0 2px">Disable individual capabilities (dropped from <code class="fn__code">ctx</code> for every block):</div>
    ${TOGGLEABLE.map((cap) => row(`sbCap_${cap}`, `Disable "${cap}"`,
        cap === "api" ? "Block code cannot call the SiYuan kernel." :
            cap === "network" ? "Block code cannot make network requests." :
                "Block code cannot read/write persisted state.",
        policy.disabled.includes(cap))).join("")}
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">Cancel</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text">Save</button>
</div>`,
    });

    const buttons = dialog.element.querySelectorAll(".b3-dialog__action .b3-button");
    buttons[0].addEventListener("click", () => dialog.destroy());
    buttons[1].addEventListener("click", () => {
        const kill = (dialog.element.querySelector("#sbKill") as HTMLInputElement).checked;
        const disabled: Capability[] = TOGGLEABLE.filter(
            (cap) => (dialog.element.querySelector(`#sbCap_${cap}`) as HTMLInputElement).checked,
        );
        const next: SuperBlockPolicy = {kill, disabled};
        setPolicy(next);
        reRenderAll();
        dialog.destroy();
    });
};
