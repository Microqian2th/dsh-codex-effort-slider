/**
 * dsh-codex-effort-slider — black-box tests: drag-to-switch-effort on the Model selection widget
 * (the official collapsed model trigger, the "seat").
 *
 * Run: `node test/seat-drag.test.mjs` — exit code 0 when every assertion passes, 1 otherwise.
 *
 * Every expected value is derived from the feature contract (R1–R9 below), never from
 * lib/client.js. The only implementation knowledge used is the exported constants and pure
 * helpers the contract names (SEAT_DRAG_SLOP_PX, SEAT_BAR_TRACK_PX, KNOB_SIZE, seatBarStepPx,
 * seatDragIndex, knobOffsetOf, pctFromIndex). The component is the one the plugin registers with the
 * host slot (host.registered[0].Component), mounted with { sessionId, locked } inside the composer.
 *
 *   R1 gesture = native pointer events on the seat button (down → move… → up/cancel → click)
 *   R2 drag starts only when |dx| > slop and |dx| > |dy|; vertical-first (|dy| > slop, |dy| >= |dx|) abandons
 *   R3 level = clamp(start + round(dx / step), 0, count − 1), step = (TRACK − KNOB) / (count − 1), right = higher
 *   R4 clamps at both ends, never wraps
 *   R5 seat bar (data-ces-part="seatbar") with id/index/value/knob, live while dragging, gone after release
 *   R6 applied through directory.select({ provider, model, reasoningEffort }); zero selects if level never changed
 *   R7 a plain click passes through untouched; the click right after a completed drag is cancelled
 *   R8 no drag when locked, seat disabled, fewer than 2 levels, or levels not loaded
 *   R9 the in-menu slider (data-ces-part="track") still renders when the official menu is open
 *
 * Techniques: Boundary Value Analysis (slop vs slop+1, half-step rounding, first/last clamps),
 * Equivalence Partitioning (left/right, horizontal/vertical, locked/unlocked, 1/2/4/6 levels),
 * a Decision Table (locked × levels≥2 × horizontal intent) and State Transitions
 * (idle → pending → dragging → released; idle → pending → abandoned; dragging → cancelled).
 *
 * Fidelity notes for the fake world (not requirements, just making the fake behave like the app):
 *   · the official seat (and menu row) always displays the current effort name, so the fake mirrors
 *     the store's reasoningEffort into those spans and then fires the MutationObserver stubs;
 *   · performance.now() in the bundle reads a fake clock, so every real wait also advances it.
 */
import { fileURLToPath } from "node:url";
import { createDocument, createFakeHost, createOfficialMenu, DEFAULT_MODEL, loadBundle, settle, wait } from "./harness.mjs";

const BUNDLE = fileURLToPath(new URL("../lib/client.js", import.meta.url));

/** Test parameters. These are scenario choices, not implementation values. */
const TEST = Object.freeze({
  sessionId: "session-abcdef",
  /** Provider id that createFakeHost puts in the store's `current` selection. */
  provider: "deepseek",
  originX: 100,
  originY: 10,
  /** R6: "allow > 120 ms for throttling". */
  throttleSettleMs: 200,
  /** A click this long after a drag no longer "immediately follows" it (R7). */
  laterClickGapMs: 1000,
  /** Far beyond any track length, used for clamp checks (R4). */
  farPx: 1000,
  /** Range for the exhaustive pure-mapping sweep. */
  sweepPx: 400,
});

/* ───────────────────────────── reporting (same style as client.test.mjs) ───────────────────────────── */

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  // `===` as well as Object.is so that an index of -0 still equals 0.
  const same = Object.is(actual, expected) || (typeof actual === "number" && actual === expected);
  ok(same, same ? label : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function near(actual, expected, label, tolerance = 1e-9) {
  const same = typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
  ok(same, same ? label : `${label} (expected ≈${expected}, got ${actual})`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

/* ───────────────────────────── models (equivalence classes by level count) ───────────────────────────── */

const level = (id, name) => ({ id, name });
const MODELS = Object.freeze({
  four: DEFAULT_MODEL, // Off, Low, High, Max; default high
  two: {
    id: "two-level-model",
    name: "Two-Level",
    reasoning: { defaultEffort: "high", efforts: [level("low", "Low"), level("high", "High")] },
  },
  six: {
    id: "six-level-model",
    name: "Six-Level",
    reasoning: {
      defaultEffort: "medium",
      efforts: [
        level("minimal", "Minimal"),
        level("low", "Low"),
        level("medium", "Medium"),
        level("high", "High"),
        level("xhigh", "XHigh"),
        level("max", "Max"),
      ],
    },
  },
  one: {
    id: "one-level-model",
    name: "One-Level",
    reasoning: { defaultEffort: "high", efforts: [level("high", "High")] },
  },
  plain: { id: "plain-model", name: "Plain" }, // no reasoning at all
});

function catalogLevels(model) {
  return model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
}

function indexOfId(model, id) {
  return catalogLevels(model).findIndex((entry) => entry.id === id);
}

/** Effective level id: the explicit session effort, else the catalog default. */
function effectiveId(model, effort) {
  return effort ?? (model.reasoning ? model.reasoning.defaultEffort : undefined);
}

/** Name the official seat shows for an effort id (null when the id is not in the catalog). */
function nameOf(model, id) {
  const found = catalogLevels(model).find((entry) => entry.id === id);
  return found ? found.name : null;
}

/* ───────────────────────────── requirement reference formulas (R3) ───────────────────────────── */

const I = loadBundle(BUNDLE, createDocument()).plugin.__internals;
const SLOP = I.SEAT_DRAG_SLOP_PX;

/** R3: one level per (SEAT_BAR_TRACK_PX − KNOB_SIZE) / (count − 1) px. */
function refStep(count) {
  return (I.SEAT_BAR_TRACK_PX - I.KNOB_SIZE) / (count - 1);
}

/** R3 + R4: clamp(start + Math.round(dx / step), 0, count − 1). */
function refIndex(start, dx, count) {
  return Math.min(count - 1, Math.max(0, start + Math.round(dx / refStep(count))));
}

/** Smallest integer dx > 0 that moves one level right: Math.round(+0.5) rounds up, so exactly half a step counts. */
function rightEdge(count) {
  return Math.ceil(refStep(count) / 2);
}

/** Smallest integer d > 0 such that dx = −d moves one level left: Math.round(−0.5) is −0, so it must exceed half a step. */
function leftEdge(count) {
  return Math.floor(refStep(count) / 2) + 1;
}

/* ───────────────────────────── scenario helpers ───────────────────────────── */

const live = [];

/**
 * Builds a fake official composer + seat, loads the real bundle, and mounts the registered slot
 * component inside the composer (same placement as client.test.mjs).
 *
 * @param options.model         catalog model (default 4 levels)
 * @param options.effort        explicit session effort id (undefined = catalog default)
 * @param options.effortLabel   seat effort span text (default = name of the effective level)
 * @param options.open          official menu open (default false = collapsed seat)
 * @param options.locked        component `locked` prop
 * @param options.host          extra createFakeHost options (e.g. throwDirectoryFor)
 * @param options.otherComposer also build a foreign composer + seat before ours
 * @param options.beforeMount   (host) => void, runs before apply/mount
 */
async function setup(options = {}) {
  const model = options.model ?? MODELS.four;
  const document = createDocument();
  const label = options.effortLabel ?? nameOf(model, effectiveId(model, options.effort)) ?? "High";
  const menuOptions = { modelLabel: model.name, effortLabel: label, reasoning: catalogLevels(model).length > 0 };
  const other = options.otherComposer === true ? createOfficialMenu(document, { ...menuOptions, open: false }) : null;
  const menu = createOfficialMenu(document, { ...menuOptions, open: options.open === true });
  const bundle = loadBundle(BUNDLE, document, {});
  const host = createFakeHost({ ...(options.host ?? {}), model, effort: options.effort });
  if (typeof options.beforeMount === "function") options.beforeMount(host);
  const ctx = { document, menu, other, bundle, react: bundle.react, host, model };
  mirrorOfficialLabels(ctx);
  bundle.plugin.apply(host.ctx);
  const entry = host.registered[0];
  if (!entry) throw new Error("plugin registered no slot entry");
  bundle.react.mount(entry.Component, { sessionId: TEST.sessionId, locked: options.locked === true }, menu.composer);
  live.push(ctx);
  await rescan(ctx);
  return ctx;
}

/** The official seat and menu row re-render the current effort name; the fake DOM needs it done for it. */
function mirrorOfficialLabels(ctx) {
  ctx.host.store.subscribe(() => {
    const name = nameOf(ctx.model, effectiveId(ctx.model, ctx.host.store.getSnapshot().current.reasoningEffort));
    if (name === null || ctx.menu.seatEffortEl.textContent === name) return;
    ctx.menu.seatEffortEl.textContent = name;
    if (ctx.menu.effortValueEl) ctx.menu.effortValueEl.textContent = name;
    queueMicrotask(() => ctx.bundle.flushObservers()); // a real MutationObserver reports the text change
  });
}

/** Let renders settle and fire the MutationObserver stubs (what the real DOM would do on change). */
async function rescan(ctx) {
  await settle();
  ctx.bundle.flushObservers();
  await settle();
}

/** Let real and fake time pass together. */
async function pass(ctx, ms) {
  ctx.bundle.advanceClock(ms);
  await wait(ms);
  await settle();
}

function afterRelease(ctx) {
  return pass(ctx, TEST.throttleSettleMs);
}

function effortOf(ctx) {
  return ctx.host.store.getSnapshot().current.reasoningEffort;
}

/**
 * Native pointer events on a seat (R1), in browser order, with stopPropagation/preventDefault spies.
 * Coordinates are relative to the pointerdown origin.
 */
function gesture(seat, x0 = TEST.originX, y0 = TEST.originY) {
  const send = (type, dx, dy, button, buttons) => {
    const calls = { stopPropagation: 0, preventDefault: 0 };
    seat.dispatch(type, {
      currentTarget: seat,
      clientX: x0 + dx,
      clientY: y0 + dy,
      button,
      buttons,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
      stopPropagation() { calls.stopPropagation += 1; },
      preventDefault() { calls.preventDefault += 1; },
    });
    return calls;
  };
  return {
    down: () => send("pointerdown", 0, 0, 0, 1),
    move: (dx, dy = 0) => send("pointermove", dx, dy, -1, 1),
    up: (dx, dy = 0) => send("pointerup", dx, dy, 0, 0),
    cancel: (dx, dy = 0) => send("pointercancel", dx, dy, -1, 0),
    click: (dx, dy = 0) => send("click", dx, dy, 0, 0),
  };
}

/** pointerup immediately followed by the browser's click on the same target; returns the click's spies. */
function release(g, dx, dy = 0) {
  g.up(dx, dy);
  return g.click(dx, dy);
}

/** Full gesture: down, one move to (dx, dy), settle, up + click, settle. Returns the click's spies. */
async function dragTo(ctx, dx, dy = 0, seat = ctx.menu.seat) {
  const g = gesture(seat);
  g.down();
  g.move(dx, dy);
  await settle();
  const clickCalls = release(g, dx, dy);
  await settle();
  return clickCalls;
}

/* ───────────────────────────── seat-bar probes (R5) ───────────────────────────── */

function partWithin(root, part) {
  return root ? root.querySelector(`[data-ces-part="${part}"]`) : null;
}

/** Every live seat bar: the React tree + portals, plus anything attached to the document. */
function seatBars(ctx) {
  const found = new Set(ctx.react.findAll("seatbar"));
  for (const node of ctx.document.querySelectorAll('[data-ces-part="seatbar"]')) found.add(node);
  return [...found];
}

function expectNoBar(ctx, tag) {
  eq(seatBars(ctx).length, 0, `${tag}: no seat bar`);
}

function expectBar(ctx, index, tag) {
  const levels = catalogLevels(ctx.model);
  const count = levels.length;
  const target = levels[index];
  const bars = seatBars(ctx);
  eq(bars.length, 1, `${tag}: exactly one seat bar is shown`);
  if (bars.length === 0) return;
  const bar = bars[0];
  eq(bar.getAttribute("data-level-id"), target.id, `${tag}: data-level-id = "${target.id}"`);
  eq(bar.getAttribute("data-level-index"), String(index), `${tag}: data-level-index = "${index}"`);
  const value = partWithin(bar, "seatbar-value");
  eq(value ? String(value.textContent) : null, target.name, `${tag}: seatbar-value text = "${target.name}"`);
  const knob = partWithin(bar, "knob");
  eq(knob ? knob.style.left : null, I.knobOffsetOf(I.pctFromIndex(index, count)), `${tag}: knob left = knobOffsetOf(pctFromIndex(${index}, ${count}))`);
}

/* ───────────────────────────── host-write probes (R6) ───────────────────────────── */

function expectApplied(ctx, levelId, tag) {
  eq(effortOf(ctx), levelId, `${tag}: store current.reasoningEffort = "${levelId}"`);
  const selects = ctx.host.selects;
  ok(selects.length >= 1, `${tag}: at least one directory.select issued (got ${selects.length})`);
  const last = selects[selects.length - 1];
  eq(last ? last.reasoningEffort : undefined, levelId, `${tag}: last select has reasoningEffort "${levelId}"`);
  ok(
    selects.length > 0 && selects.every((s) => s.provider === TEST.provider && s.model === ctx.model.id),
    `${tag}: every select is { provider: "${TEST.provider}", model: "${ctx.model.id}", reasoningEffort }`,
  );
}

function expectSelectCount(ctx, expected, tag) {
  eq(ctx.host.selects.length, expected, `${tag}: directory.select count = ${expected}`);
}

/** No-drag scenario: a clear horizontal drag must produce no bar, no select and must not cancel the click. */
async function expectNoDrag(ctx, tag, seat = ctx.menu.seat) {
  const g = gesture(seat);
  const before = ctx.host.selects.length;
  const effortBefore = effortOf(ctx);
  g.down();
  await settle();
  for (const [dx, what] of [[SLOP + 1, "slop + 1 right"], [refStep(4), "one 4-level step right"], [TEST.farPx, "far right"]]) {
    g.move(dx);
    await settle();
    expectNoBar(ctx, `${tag}: ${what}`);
  }
  const clickCalls = release(g, TEST.farPx);
  await settle();
  eq(clickCalls.stopPropagation, 0, `${tag}: click is not cancelled (no drag happened)`);
  await afterRelease(ctx);
  expectSelectCount(ctx, before, tag);
  eq(effortOf(ctx), effortBefore, `${tag}: effort unchanged`);
}

/* ───────────────────────────── case runner ───────────────────────────── */

/** Runs one case; a thrown error counts as a failure and does not stop the suite. */
async function runCase(id, body) {
  try {
    await body();
  } catch (error) {
    const where = error && error.stack ? error.stack.split("\n").slice(0, 2).join(" | ") : String(error);
    ok(false, `${id} threw: ${where}`);
  } finally {
    while (live.length > 0) {
      const ctx = live.pop();
      try { ctx.react.unmount(); } catch (error) { /* teardown must not mask results */ }
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

section("A. Pure mapping: step, rounding, clamps (R3, R4) — BVA + EP");
await runCase("[A]", async () => {
  ok(typeof I.seatBarStepPx === "function" && typeof I.seatDragIndex === "function", "[A0] seatBarStepPx / seatDragIndex are exported");
  ok(Number.isFinite(SLOP) && SLOP > 0, `[A0] SEAT_DRAG_SLOP_PX is a positive number (${SLOP})`);
  ok(Number.isFinite(I.SEAT_BAR_TRACK_PX) && I.SEAT_BAR_TRACK_PX > I.KNOB_SIZE, `[A0] SEAT_BAR_TRACK_PX (${I.SEAT_BAR_TRACK_PX}) > KNOB_SIZE (${I.KNOB_SIZE})`);

  for (const count of [2, 3, 4, 6]) {
    near(I.seatBarStepPx(count), refStep(count), `[A1] seatBarStepPx(${count}) = (TRACK − KNOB)/(${count} − 1) = ${refStep(count)}`);
  }

  // A2: BVA spot checks, 4 levels, starting at High (index 2).
  const step = refStep(4);
  const spots = [
    ["no movement", 0],
    ["slop + 1", SLOP + 1],
    ["just under half a step right", rightEdge(4) - 1],
    ["exactly half a step right (Math.round(0.5) = 1)", rightEdge(4)],
    ["exactly half a step left (Math.round(−0.5) = −0)", -(leftEdge(4) - 1)],
    ["just over half a step left", -leftEdge(4)],
    ["one step right", step],
    ["two steps right (clamp at Max)", 2 * step],
    ["one step left", -step],
    ["1.5 steps left (Math.round(−1.5) = −1)", -1.5 * step],
    ["just over 1.5 steps left", -(1.5 * step + 1)],
    ["two steps left (first level)", -2 * step],
    ["three steps left (clamp at Off)", -3 * step],
    ["far left", -TEST.farPx],
    ["far right", TEST.farPx],
  ];
  for (const [what, dx] of spots) {
    eq(I.seatDragIndex(2, dx, 4), refIndex(2, dx, 4), `[A2] start=2, dx=${dx} (${what}) → ${refIndex(2, dx, 4)}`);
  }
  // Ends: dragging past the first/last level stays there, no wrap-around.
  eq(I.seatDragIndex(0, -1, 4), 0, "[A2] start=0 (Off), dx=−1 → 0 (no wrap to Max)");
  eq(I.seatDragIndex(0, -TEST.farPx, 4), 0, "[A2] start=0, far left → 0");
  eq(I.seatDragIndex(3, 1, 4), 3, "[A2] start=3 (Max), dx=+1 → 3");
  eq(I.seatDragIndex(3, TEST.farPx, 4), 3, "[A2] start=3, far right → 3 (no wrap to Off)");
  eq(I.seatDragIndex(0, TEST.farPx, 4), 3, "[A2] start=0, far right → last level");
  eq(I.seatDragIndex(3, -TEST.farPx, 4), 0, "[A2] start=3, far left → first level");

  // A3: exhaustive integer sweep vs. the R3 formula for every level count 2..6 and first/middle/last start.
  for (const count of [2, 3, 4, 5, 6]) {
    const starts = [...new Set([0, Math.floor((count - 1) / 2), count - 1])];
    for (const start of starts) {
      let mismatch = null;
      let mismatches = 0;
      for (let dx = -TEST.sweepPx; dx <= TEST.sweepPx; dx += 1) {
        const got = I.seatDragIndex(start, dx, count);
        const want = refIndex(start, dx, count);
        if (got !== want) {
          mismatches += 1;
          if (mismatch === null) mismatch = `dx=${dx}: got ${got}, want ${want}`;
        }
      }
      ok(mismatches === 0, `[A3] count=${count}, start=${start}: seatDragIndex = clamp(start + round(dx/step)) for dx ∈ [−${TEST.sweepPx}, ${TEST.sweepPx}]${mismatch ? ` (${mismatches} mismatches, first ${mismatch})` : ""}`);
    }
  }

  // A4: properties — integer, inside [0, count−1], non-decreasing in dx (right never lowers effort).
  for (const count of [2, 4, 6]) {
    let good = true;
    for (let start = 0; start < count && good; start += 1) {
      let previous = -Infinity;
      for (let dx = -TEST.sweepPx; dx <= TEST.sweepPx; dx += 1) {
        const value = I.seatDragIndex(start, dx, count);
        if (!Number.isInteger(value) || value < 0 || value > count - 1 || value < previous) { good = false; break; }
        previous = value;
      }
    }
    ok(good, `[A4] count=${count}: result is an integer in [0, ${count - 1}] and never decreases as dx grows`);
  }
});

section("B. Live bar while dragging the collapsed seat (R1–R7) — idle → pending → dragging → released");
await runCase("[B]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  const start = indexOfId(ctx.model, "high");
  const step = refStep(4);
  expectNoBar(ctx, "[B1] idle, before pointerdown");

  g.down();
  await settle();
  expectNoBar(ctx, "[B2] pending, right after pointerdown");

  g.move(SLOP, 0);
  await settle();
  expectNoBar(ctx, `[B3] pending, |dx| = slop (${SLOP}) is not beyond the slop`);

  const path = [
    [SLOP + 1, 0, "slop + 1 → drag starts"],
    [rightEdge(4) - 1, 0, "just under half a step right"],
    [rightEdge(4), 0, "exactly half a step right"],
    [step, 0, "one step right"],
    [step, 30, "one step right with vertical drift after the drag started"],
    [3 * step, 0, "three steps right (clamp at last level)"],
    [TEST.farPx, 0, "far right (still last level, no wrap)"],
    [0, 0, "back at the origin (still dragging, start level)"],
    [-(leftEdge(4) - 1), 0, "exactly half a step left"],
    [-leftEdge(4), 0, "just over half a step left"],
    [-1.5 * step, 0, "1.5 steps left"],
    [-(1.5 * step + 1), 0, "just over 1.5 steps left"],
    [-3 * step, 0, "three steps left (clamp at first level)"],
    [-TEST.farPx, 0, "far left (still first level, no wrap)"],
    [-step, 0, "one step left (final position)"],
  ];
  let lastShown = start;
  for (const [dx, dy, what] of path) {
    g.move(dx, dy);
    await settle();
    lastShown = refIndex(start, dx, 4);
    expectBar(ctx, lastShown, `[B4] dx=${dx}, dy=${dy} (${what})`);
  }

  const clickCalls = release(g, -step);
  await settle();
  expectNoBar(ctx, "[B5] released (pointerup)");
  ok(clickCalls.stopPropagation >= 1, "[B5] the click that follows the completed drag is cancelled (stopPropagation called)");
  await afterRelease(ctx);
  expectApplied(ctx, catalogLevels(ctx.model)[lastShown].id, "[B6] after release");
});

section("C. Click compatibility (R7) — BVA on the slop");
await runCase("[C1]", async () => {
  const ctx = await setup({ effort: "high" });
  const clickCalls = await dragTo(ctx, 0, 0);
  eq(clickCalls.stopPropagation, 0, "[C1] plain click without movement: click.stopPropagation not called");
  eq(clickCalls.preventDefault, 0, "[C1] plain click without movement: click.preventDefault not called");
  expectNoBar(ctx, "[C1] plain click without movement");
  await afterRelease(ctx);
  expectSelectCount(ctx, 0, "[C1] plain click without movement");
  eq(effortOf(ctx), "high", "[C1] effort unchanged");
});

await runCase("[C2]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(SLOP, SLOP);
  await settle();
  expectNoBar(ctx, `[C2] jitter of exactly the slop (dx=${SLOP}, dy=${SLOP})`);
  g.move(-SLOP, 0);
  await settle();
  expectNoBar(ctx, `[C2] jitter of exactly the slop to the left (dx=−${SLOP})`);
  const clickCalls = release(g, -SLOP, 0);
  await settle();
  eq(clickCalls.stopPropagation, 0, "[C2] click after within-slop jitter: stopPropagation not called");
  eq(clickCalls.preventDefault, 0, "[C2] click after within-slop jitter: preventDefault not called");
  expectNoBar(ctx, "[C2] after release");
  await afterRelease(ctx);
  expectSelectCount(ctx, 0, "[C2] within-slop jitter");
});

await runCase("[C3]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[C3] dragged one step right");
  const clickCalls = release(g, refStep(4));
  await settle();
  ok(clickCalls.stopPropagation >= 1, "[C3] click immediately after a completed drag is cancelled (stopPropagation)");
  await afterRelease(ctx);
  expectApplied(ctx, "max", "[C3]");

  // C4: a later, separate plain click must reach the official menu again.
  await pass(ctx, TEST.laterClickGapMs);
  await rescan(ctx);
  const before = ctx.host.selects.length;
  const later = await dragTo(ctx, 0, 0);
  eq(later.stopPropagation, 0, `[C4] a plain click ${TEST.laterClickGapMs} ms after the drag is not cancelled (stopPropagation)`);
  eq(later.preventDefault, 0, "[C4] … and not preventDefault-ed");
  expectNoBar(ctx, "[C4] later plain click");
  await afterRelease(ctx);
  expectSelectCount(ctx, before, "[C4] later plain click adds no select");
});

await runCase("[C5]", async () => {
  // A drag released without a trailing click (pointerup outside the seat): the next, separate plain click passes.
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(-refStep(4));
  await settle();
  expectBar(ctx, 1, "[C5] dragged one step left");
  g.up(-refStep(4));
  await settle();
  expectNoBar(ctx, "[C5] released without a click");
  await afterRelease(ctx);
  expectApplied(ctx, "low", "[C5]");
  await pass(ctx, TEST.laterClickGapMs);
  await rescan(ctx);
  const later = await dragTo(ctx, 0, 0);
  eq(later.stopPropagation, 0, `[C5] first plain click ${TEST.laterClickGapMs} ms after a click-less drag is not cancelled`);
});

section("D. Horizontal vs vertical intent (R2) — EP + BVA; idle → pending → abandoned");
await runCase("[D1]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(0, SLOP + 1);
  await settle();
  expectNoBar(ctx, `[D1] vertical first (dy=${SLOP + 1}, dx=0) → abandoned`);
  g.move(2 * refStep(4), SLOP + 1);
  await settle();
  expectNoBar(ctx, "[D1] later horizontal movement in the same gesture still shows no bar");
  g.move(TEST.farPx, 0);
  await settle();
  expectNoBar(ctx, "[D1] even far right with dy back to 0");
  release(g, TEST.farPx, 0);
  await settle();
  await afterRelease(ctx);
  expectSelectCount(ctx, 0, "[D1] abandoned gesture");
  eq(effortOf(ctx), "high", "[D1] effort unchanged after abandoned gesture");

  // D5: abandoned → idle: the next gesture drags normally.
  const g2 = gesture(ctx.menu.seat);
  g2.down();
  g2.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[D5] next gesture after an abandoned one drags again");
  release(g2, refStep(4));
  await settle();
  await afterRelease(ctx);
  expectApplied(ctx, "max", "[D5]");
});

await runCase("[D2]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(-(SLOP + 1), -(SLOP + 1));
  await settle();
  expectNoBar(ctx, `[D2] tie |dx| = |dy| = ${SLOP + 1} (up-left) → vertical wins, abandoned`);
  g.move(-2 * refStep(4), -(SLOP + 1));
  await settle();
  expectNoBar(ctx, "[D2] further left movement in the same gesture shows no bar");
  release(g, -2 * refStep(4), -(SLOP + 1));
  await settle();
  await afterRelease(ctx);
  expectSelectCount(ctx, 0, "[D2] abandoned tie gesture");
});

await runCase("[D3]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(0, SLOP);
  await settle();
  expectNoBar(ctx, `[D3] dy = slop (${SLOP}) does not abandon, still pending`);
  g.move(SLOP + 1, SLOP);
  await settle();
  expectBar(ctx, 2, "[D3] then dx = slop + 1 with dy = slop → drag starts at High");
  g.move(refStep(4), SLOP);
  await settle();
  expectBar(ctx, 3, "[D3] one step right → Max");
  const clickCalls = release(g, refStep(4), SLOP);
  await settle();
  ok(clickCalls.stopPropagation >= 1, "[D3] click after this drag is cancelled");
  await afterRelease(ctx);
  expectApplied(ctx, "max", "[D3]");
});

await runCase("[D4]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(SLOP + 2, SLOP + 1);
  await settle();
  expectBar(ctx, 2, `[D4] one diagonal move dx=${SLOP + 2} > dy=${SLOP + 1} > slop → horizontal, drag starts`);
  const clickCalls = release(g, SLOP + 2, SLOP + 1);
  await settle();
  expectNoBar(ctx, "[D4] released");
  ok(clickCalls.stopPropagation >= 1, "[D4] click after a completed drag is cancelled even when the level never changed");
  await afterRelease(ctx);
  expectSelectCount(ctx, 0, "[D4] shown level never differed from the start level");
  eq(effortOf(ctx), "high", "[D4] effort unchanged");
});

section("E. Direction and end clamps on the real seat (R3, R4, R6) — EP left/right + BVA first/last");
{
  const cases = [
    { id: "E1", effort: "high", moves: [refStep(4)], shown: [3], applied: "max", what: "RIGHT one step from High → Max (higher effort)" },
    { id: "E2", effort: "high", moves: [-refStep(4)], shown: [1], applied: "low", what: "LEFT one step from High → Low (lower effort)" },
    { id: "E3", effort: "max", moves: [SLOP + 1, TEST.farPx], shown: [3, 3], applied: null, what: "start at Max (last level): slop + 1 right, then far right stays Max (no wrap to Off)" },
    { id: "E4", effort: "off", moves: [-(SLOP + 1), -TEST.farPx], shown: [0, 0], applied: null, what: "start at Off (first level): slop + 1 left, then far left stays Off (no wrap to Max)" },
    { id: "E5", effort: undefined, moves: [SLOP + 1, refStep(4)], shown: [2, 3], applied: "max", what: "no explicit effort → start = catalog default High; one step right → Max" },
  ];
  for (const c of cases) {
    await runCase(`[${c.id}]`, async () => {
      const ctx = await setup({ effort: c.effort });
      const g = gesture(ctx.menu.seat);
      g.down();
      for (let i = 0; i < c.moves.length; i += 1) {
        g.move(c.moves[i]);
        await settle();
        expectBar(ctx, c.shown[i], `[${c.id}] ${c.what} — move ${i + 1}, dx=${c.moves[i]}`);
      }
      release(g, c.moves[c.moves.length - 1]);
      await settle();
      expectNoBar(ctx, `[${c.id}] released`);
      await afterRelease(ctx);
      if (c.applied === null) {
        expectSelectCount(ctx, 0, `[${c.id}] level never changed`);
        eq(effortOf(ctx), c.effort, `[${c.id}] effort stays "${c.effort}"`);
      } else {
        expectApplied(ctx, c.applied, `[${c.id}]`);
      }
    });
  }
}

section("F. Start index is fixed at pointerdown even if a throttled select lands mid-drag (R3, R6)");
await runCase("[F1]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[F1] one step right → Max");
  await pass(ctx, TEST.throttleSettleMs); // a throttled mid-drag select may now have written "max"
  expectBar(ctx, 3, `[F1] still dragging after ${TEST.throttleSettleMs} ms → bar still shows Max`);
  g.move(0);
  await settle();
  expectBar(ctx, 2, "[F1] back to dx=0 → High (start = level at pointerdown, not the mid-drag write)");
  release(g, 0);
  await settle();
  expectNoBar(ctx, "[F1] released");
  await afterRelease(ctx);
  eq(effortOf(ctx), "high", "[F1] store ends at the level last shown (high)");
  const selects = ctx.host.selects;
  ok(
    selects.length === 0 || selects[selects.length - 1].reasoningEffort === "high",
    `[F1] if any select was issued, the last one is "high" (selects: ${JSON.stringify(selects.map((s) => s.reasoningEffort))})`,
  );
});

section("G. Level counts 2 / 6 / 1 / none (R3, R8) — EP");
await runCase("[G1]", async () => {
  const ctx = await setup({ model: MODELS.two, effort: "high" });
  const g = gesture(ctx.menu.seat);
  const half = leftEdge(2) - 1;
  g.down();
  g.move(SLOP + 1);
  await settle();
  expectBar(ctx, 1, "[G1] 2 levels, start High (index 1), slop + 1");
  g.move(TEST.farPx);
  await settle();
  expectBar(ctx, 1, "[G1] far right stays High (last level)");
  g.move(-half);
  await settle();
  expectBar(ctx, refIndex(1, -half, 2), `[G1] dx=−${half} (exactly half of step ${refStep(2)}) → High`);
  g.move(-leftEdge(2));
  await settle();
  expectBar(ctx, 0, `[G1] dx=−${leftEdge(2)} (just over half a step) → Low`);
  release(g, -leftEdge(2));
  await settle();
  await afterRelease(ctx);
  expectApplied(ctx, "low", "[G1]");
});

await runCase("[G2]", async () => {
  const ctx = await setup({ model: MODELS.six, effort: "medium" });
  const g = gesture(ctx.menu.seat);
  const start = indexOfId(ctx.model, "medium");
  const twoSteps = Math.round(2 * refStep(6));
  g.down();
  const moves = [
    [rightEdge(6) - 1, "just under half a step right"],
    [rightEdge(6), "just past half a step right"],
    [twoSteps, "two steps right"],
    [TEST.farPx, "far right (last level)"],
    [-TEST.farPx, "far left (first level)"],
    [twoSteps, "two steps right (final)"],
  ];
  for (const [dx, what] of moves) {
    g.move(dx);
    await settle();
    expectBar(ctx, refIndex(start, dx, 6), `[G2] 6 levels, start Medium, dx=${dx} (${what})`);
  }
  release(g, twoSteps);
  await settle();
  await afterRelease(ctx);
  expectApplied(ctx, catalogLevels(ctx.model)[refIndex(start, twoSteps, 6)].id, "[G2]");
});

await runCase("[G3]", async () => {
  const ctx = await setup({ model: MODELS.one, effort: "high" });
  await expectNoDrag(ctx, "[G3] 1 level");
});

await runCase("[G4]", async () => {
  const ctx = await setup({ model: MODELS.plain, effortLabel: "High" });
  await expectNoDrag(ctx, "[G4] model without reasoning");
});

section("H. Preconditions that disable the drag (R8) + which seat counts");
await runCase("[H1]", async () => {
  const ctx = await setup({ effort: "high", locked: true });
  await expectNoDrag(ctx, "[H1] locked = true");
});

await runCase("[H2]", async () => {
  const ctx = await setup({ effort: "high" });
  ctx.menu.seat.disabled = true;
  await expectNoDrag(ctx, "[H2] seat.disabled === true");
  ctx.menu.seat.disabled = false;
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[H2] re-enabled seat drags again (positive control)");
  release(g, refStep(4));
  await settle();
});

await runCase("[H3]", async () => {
  let loaded = null;
  const ctx = await setup({
    effort: "high",
    beforeMount(host) {
      loaded = host.store.getSnapshot();
      host.store.set({ ...loaded, groups: [], status: "loading" });
    },
  });
  await expectNoDrag(ctx, "[H3] levels not loaded (catalog empty, status loading)");
  ctx.host.store.set(loaded);
  await rescan(ctx);
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[H3] after the catalog loads, the same seat drags (High → Max)");
  release(g, refStep(4));
  await settle();
  await afterRelease(ctx);
  expectApplied(ctx, "max", "[H3] after load");
});

await runCase("[H4]", async () => {
  const ctx = await setup({ effort: "high", host: { throwDirectoryFor: true } });
  await expectNoDrag(ctx, "[H4] model directory unavailable (levels never load)");
});

await runCase("[H5]", async () => {
  const ctx = await setup({ effort: "high", otherComposer: true });
  await expectNoDrag(ctx, "[H5] seat in a different composer (not the one holding the anchor)", ctx.other.seat);
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[H5] the seat in our own composer drags (positive control)");
  release(g, refStep(4));
  await settle();
});

await runCase("[H6]", async () => {
  const ctx = await setup({ effort: "high", effortLabel: "Turbo" });
  await expectNoDrag(ctx, "[H6] seat with no span equal to an effort level name");
});

section("DT. Decision table: locked × levels ≥ 2 × horizontal intent → drag (R2, R8)");
{
  const rules = [];
  for (const locked of [false, true]) {
    for (const many of [true, false]) {
      for (const horizontal of [true, false]) rules.push({ locked, many, horizontal, drag: !locked && many && horizontal });
    }
  }
  const yn = (flag) => (flag ? "Y" : "N");
  for (let i = 0; i < rules.length; i += 1) {
    const r = rules[i];
    const tag = `[DT-${i + 1}] locked=${yn(r.locked)} levels≥2=${yn(r.many)} horizontal=${yn(r.horizontal)} → drag=${yn(r.drag)}`;
    await runCase(tag, async () => {
      const ctx = await setup({ model: r.many ? MODELS.four : MODELS.one, effort: "high", locked: r.locked });
      const g = gesture(ctx.menu.seat);
      const dx = r.horizontal ? refStep(4) : 0;
      const dy = r.horizontal ? 0 : refStep(4);
      g.down();
      g.move(dx, dy);
      await settle();
      eq(seatBars(ctx).length, r.drag ? 1 : 0, `${tag}: seat bar count while moving`);
      const clickCalls = release(g, dx, dy);
      await settle();
      eq(seatBars(ctx).length, 0, `${tag}: no bar after release`);
      // A vertical move beyond the slop is not a plain click, so R7 says nothing about that click.
      if (r.horizontal) eq(clickCalls.stopPropagation >= 1, r.drag, `${tag}: trailing click cancelled only if a drag completed`);
      await afterRelease(ctx);
      if (r.drag) {
        expectApplied(ctx, "max", tag);
      } else {
        expectSelectCount(ctx, 0, tag);
        eq(effortOf(ctx), "high", `${tag}: effort unchanged`);
      }
    });
  }
}

section("J. State transitions: pointercancel and consecutive drags (R3, R5, R6)");
await runCase("[J1]", async () => {
  const ctx = await setup({ effort: "high" });
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[J1] dragging → Max");
  g.cancel(refStep(4));
  await settle();
  expectNoBar(ctx, "[J1] pointercancel removes the bar");
  await afterRelease(ctx);
  const after = effortOf(ctx);
  ok(after === "high" || after === "max", `[J1] after pointercancel the effort is the start level or the last shown level (got ${JSON.stringify(after)})`);
  g.move(-TEST.farPx);
  await settle();
  expectNoBar(ctx, "[J1] moves after pointercancel (no new pointerdown) show no bar");

  // cancelled → idle: a fresh gesture starts from the effective level at its own pointerdown.
  await rescan(ctx);
  const startNow = indexOfId(ctx.model, after);
  const before = ctx.host.selects.length;
  const g2 = gesture(ctx.menu.seat);
  g2.down();
  g2.move(SLOP + 1);
  await settle();
  expectBar(ctx, startNow, "[J1] next gesture after pointercancel drags from the current level");
  release(g2, SLOP + 1);
  await settle();
  expectNoBar(ctx, "[J1] next gesture released");
  await afterRelease(ctx);
  expectSelectCount(ctx, before, "[J1] next gesture never changed level");
});

await runCase("[J2]", async () => {
  const ctx = await setup({ effort: "high" });
  await dragTo(ctx, refStep(4));
  await afterRelease(ctx);
  expectApplied(ctx, "max", "[J2] first drag High → Max");
  await rescan(ctx);

  const g2 = gesture(ctx.menu.seat, TEST.originX + 37, TEST.originY + 3);
  g2.down();
  await settle();
  expectNoBar(ctx, "[J2] second gesture pending");
  g2.move(-refStep(4));
  await settle();
  expectBar(ctx, 2, "[J2] second drag starts from Max (index 3); one step left → High");
  g2.move(-2 * refStep(4));
  await settle();
  expectBar(ctx, 1, "[J2] two steps left → Low");
  release(g2, -2 * refStep(4));
  await settle();
  await afterRelease(ctx);
  expectApplied(ctx, "low", "[J2] second drag Max → Low");
});

section("K. Official menu open: seat drag still works, in-menu slider not regressed (R1, R5, R9)");
await runCase("[K1]", async () => {
  const ctx = await setup({ effort: "high", open: true });
  ok(ctx.react.find("track") !== null, '[K1] in-menu slider (data-ces-part="track") renders when the menu is open');
  expectNoBar(ctx, "[K1] no seat bar before any gesture");
  const g = gesture(ctx.menu.seat);
  g.down();
  g.move(SLOP);
  await settle();
  expectNoBar(ctx, "[K2] menu open, |dx| = slop → still pending");
  g.move(refStep(4));
  await settle();
  expectBar(ctx, 3, "[K2] menu open, one step right → Max");
  const bar = seatBars(ctx)[0];
  ok(bar !== undefined && ctx.react.findAll("knob").some((knob) => !bar.contains(knob)), "[K2] the in-menu knob still exists outside the seat bar");
  ok(ctx.react.find("track") !== null, "[K2] in-menu slider still present during the seat drag");
  const clickCalls = release(g, refStep(4));
  await settle();
  ok(clickCalls.stopPropagation >= 1, "[K2] trailing click cancelled so the open menu does not toggle");
  expectNoBar(ctx, "[K2] released");
  await afterRelease(ctx);
  expectApplied(ctx, "max", "[K2] menu open");
  ok(ctx.react.find("track") !== null, "[K3] in-menu slider still renders after the seat drag");
});

/* ══════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? "All passed ✅" : "Failures ❌"} (${passed} passed, ${failed} failed)`);
if (failed > 0) {
  console.log("Failed:");
  for (const label of failures) console.log(`  · ${label}`);
  process.exitCode = 1;
}
