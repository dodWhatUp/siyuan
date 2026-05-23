// Super-block render path (fork feature — see notes/06-superblock-implementation-plan.md).
//
// A super-block is a NodeHTMLBlock carrying the IAL marker `custom-sb-kind`. This
// module is the DEDICATED, parallel render path for those marked blocks: it mounts
// our own runtime into the block instead of relying on the stock <protyle-html>
// shadow-DOM sandbox. Plain HTML blocks (no marker) are never matched here, so the
// existing HTML-block behaviour is untouched.
//
// Step 2 scope: detect marked blocks, mount a host, and RUN the block's code
// (from custom-sb-code) through the capability-gated runtime. No editor yet.

import {runSuperBlock} from "../superblock/runtime";

export const SB_MARKER = "custom-sb-kind";
export const SB_CODE = "custom-sb-code";

// Lazy-mount (step 6b): a super-block's code runs only when the block scrolls
// near the viewport, so a long doc with many super-blocks doesn't execute every
// one up-front. One shared IntersectionObserver serves all blocks (cheaper than
// an observer per block); each block's deferred mount is stored in a WeakMap.
let observer: IntersectionObserver | null = null;
const pendingMounts = new WeakMap<Element, () => void>();

const getObserver = (): IntersectionObserver => {
    if (!observer) {
        observer = new IntersectionObserver((entries, obs) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                    return;
                }
                const mount = pendingMounts.get(entry.target);
                if (mount) {
                    pendingMounts.delete(entry.target);
                    obs.unobserve(entry.target);
                    mount();
                }
            });
        }, {rootMargin: "200px"}); // pre-mount slightly before the block is visible
    }
    return observer;
};

export const superblockRender = (element: Element) => {
    let blocks: Element[] | NodeListOf<Element>;
    if (element.getAttribute("data-type") === "NodeHTMLBlock" && element.hasAttribute(SB_MARKER)) {
        blocks = [element];
    } else {
        blocks = element.querySelectorAll(`[data-type="NodeHTMLBlock"][${SB_MARKER}]`);
    }
    if (blocks.length === 0) {
        return;
    }
    blocks.forEach((block: HTMLElement) => {
        // Idempotent: never remount an already-rendered block (avoids the
        // re-trigger churn that plagued the plugin prototype).
        if (block.getAttribute("data-sb-rendered") === "true") {
            return;
        }
        const stock = block.querySelector("protyle-html") as HTMLElement | null;
        // The middle wrapper holds <protyle-html> + the ZWSP span.
        const wrapper = stock?.parentElement;
        if (!wrapper) {
            return;
        }
        block.setAttribute("data-sb-rendered", "true");
        const kind = block.getAttribute(SB_MARKER) || "";

        // Hide the stock sandbox output; we render in light DOM (main context).
        stock.style.display = "none";

        let host = wrapper.querySelector(":scope > .sb-host") as HTMLElement | null;
        if (!host) {
            host = document.createElement("div");
            host.className = "sb-host";
            host.setAttribute("contenteditable", "false");
            wrapper.insertBefore(host, wrapper.firstChild);
        }
        // Defer running the block's code until it scrolls near the viewport.
        const code = block.getAttribute(SB_CODE) || "";
        const blockId = block.getAttribute("data-node-id") || "";
        const runHost = host;
        pendingMounts.set(block, () => runSuperBlock(runHost, blockId, kind, code));
        getObserver().observe(block);
    });
};
