// Export registry — backs the "export" capability (ctx.onExport). A super-block's
// live output is often interactive/non-portable (timers, nested editors, canvases).
// onExport lets the block declare a STATIC representation to contribute to copies
// and exports instead. Keyed by block id; the runtime clears it on unmount.
//
// Wiring note: the runtime mirrors the registered content into the block's own
// <protyle-html data-content> on render (safe — it only touches the block's own
// DOM attribute, never the kernel or IAL). That makes DOM-based copy/export reflect
// it immediately. Persisting it into the stored .sy for kernel markdown export is a
// separate, heavier step (would require updateBlock) and is intentionally deferred.

type ExportFn = () => string;

const exportFns = new Map<string, ExportFn>();

export const registerExport = (blockId: string, fn: ExportFn): void => {
    exportFns.set(blockId, fn);
};

export const clearExport = (blockId: string): void => {
    exportFns.delete(blockId);
};

// Resolve a block's export content now. Returns undefined if none registered; a
// throwing provider is swallowed (a faulty block must not break an export).
export const getExportContent = (blockId: string): string | undefined => {
    const fn = exportFns.get(blockId);
    if (!fn) {
        return undefined;
    }
    try {
        return fn();
    } catch {
        return undefined;
    }
};

export const listExports = (): string[] => Array.from(exportFns.keys());
