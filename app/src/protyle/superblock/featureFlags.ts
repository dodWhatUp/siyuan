// =============================================================================
// Super-block feature flags — FREEZE SWITCH for the task/calendar track.
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// On 2026-05-23 the user asked to PAUSE the task-oriented features (calendar,
// database multi-view, and the reminder + location property components) and
// focus only on EMBED and SEARCH/QUERY. Rather than delete that work, we gate it
// behind a single flag so it is:
//   * not registered  → it never appears in the feature/property picker,
//   * not running      → no reminder scheduler starts, no calendar mounts,
//   * trivially revivable → flip one flag and rebuild.
//
// WHAT IS FROZEN (when isFrozen() === true)
// -----------------------------------------
//   builtinFeatures.ts   → the "calendar" and "database" features are NOT
//                          registered (so runSuperBlock can't run them, and the
//                          embedded ReminderScheduler in their run() never starts).
//   builtinProperties.ts → the "reminder" and "location" property components are
//                          NOT registered (so getProperty("reminder"/"location")
//                          returns undefined and no editor/scheduler is reachable).
//
// The supporting modules (reminderEngine, reminderScheduler, icsExport, nlDate)
// remain compiled and exported on the SPI under window.siyuan.superblock.* but are
// inert because nothing invokes them while frozen. They are pure/safe to keep.
//
// WHAT STAYS ACTIVE
// -----------------
//   The "query" (search) feature and the upcoming "embed" feature — the current
//   focus. These do NOT depend on the frozen modules.
//
// HOW TO RE-ENABLE (when the user says so)
// ----------------------------------------
//   Call setFrozen(false) at startup BEFORE registerBuiltinFeatures()/
//   registerBuiltinProperties() run (e.g. flip DEFAULT_FROZEN to false below),
//   then rebuild. Everything returns exactly as it was.
//
// TESTING NOTE
// ------------
//   The regression suite (__tests__/superblock.test.ts) calls setFrozen(false)
//   first, so the frozen code is still fully exercised — freezing the app does
//   NOT reduce test coverage, which is what keeps re-enabling safe.
// =============================================================================

const DEFAULT_FROZEN = true;   // ← task/calendar/reminder track paused. Set false to revive.

let _frozen = DEFAULT_FROZEN;

/** True when the task/calendar/reminder/location features must NOT register or run. */
export const isFrozen = (): boolean => _frozen;

/** Override the freeze (used by tests to exercise the frozen code; or to revive). */
export const setFrozen = (value: boolean): void => { _frozen = value; };
