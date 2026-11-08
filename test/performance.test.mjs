import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createDocument, createFakeHost, createOfficialMenu, loadBundle, settle, wait } from './harness.mjs';

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));
async function microtasks() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
async function createScenario() {
  const document = createDocument();
  const menu = createOfficialMenu(document);
  const bundle = loadBundle(BUNDLE, document);
  const host = createFakeHost();
  bundle.plugin.apply(host.ctx);
  bundle.react.mount(host.registered[0].Component, { sessionId: 'performance-test' }, menu.composer);
  await settle();
  return { menu, bundle, host, find: (part) => bundle.react.find(part) };
}

async function testDrag() {
  const { bundle, host, find } = await createScenario();
  const prototype = Object.getPrototypeOf(find('track'));
  const originalRect = prototype.getBoundingClientRect;
  let geometryReads = 0;
  prototype.getBoundingClientRect = function () {
    if (this.getAttribute('data-ces-part') === 'track') geometryReads++;
    return originalRect.call(this);
  };
  try {
    const before = bundle.react.renderCount;
    const timing = JSON.stringify(bundle.react.findAll('star').map((node) => [node.style.animationDuration, node.style.animationDelay]));
    find('track').fire('onPointerDown', { clientX: 14 + 0.70 * 172, pointerId: 1, buttons: 1 });
    for (let i = 0; i < 60; i++) {
      const pct = 0.70 + 0.25 * (i / 59);
      find('track').fire('onPointerMove', { clientX: 14 + pct * 172, buttons: 1 });
      bundle.flushFrames(1, 1000 / 60);
      await microtasks();
    }
    await wait(150);
    await settle();
    const counters = { renders: bundle.react.renderCount - before, geometryReads, commits: host.selects.length };
    assert.equal(counters.renders, 0, 'continuous preview must not render React');
    assert.equal(counters.geometryReads, 1, 'drag measures geometry once at pointerdown');
    assert.equal(counters.commits, 0, 'holding beyond the old throttle window must not commit');
    assert.equal(JSON.stringify(bundle.react.findAll('star').map((node) => [node.style.animationDuration, node.style.animationDelay])), timing);
    assert.equal(bundle.react.findAll('star').length, 22);
    find('track').fire('onPointerUp', {});
    for (let i = 0; i < 90; i++) { bundle.flushFrames(1, 1000 / 60); await microtasks(); }
    await settle();
    assert.equal(host.selects.length, 1);
    assert.equal(host.store.getSnapshot().current.reasoningEffort, 'max');
    return counters;
  } finally {
    prototype.getBoundingClientRect = originalRect;
    bundle.react.unmount();
  }
}

async function testClick() {
  const { menu, bundle, host, find } = await createScenario();
  const position = () => parseFloat(/translate3d\(([-\d.]+)px/.exec(find('knob').style.transform)[1]);
  const initial = position();
  let backgroundWrites = 0;
  let shadowWrites = 0;
  const instrumented = new WeakSet();
  function instrument(node) {
    if (!node || instrumented.has(node)) return;
    instrumented.add(node);
    node.style = new Proxy(node.style, {
      set(target, key, value) {
        if (key === 'background' || key === 'backgroundSize') backgroundWrites++;
        if (key === 'boxShadow') shadowWrites++;
        target[key] = value;
        return true;
      },
    });
  }
  try {
    find('track').fire('onPointerDown', { clientX: 186, pointerId: 1, buttons: 1 });
    assert.equal(menu.effortValueEl.textContent, 'Max', 'label previews the target immediately');
    assert.equal(host.selects.length, 0);
    find('track').fire('onPointerUp', {});
    await microtasks();
    const before = bundle.react.renderCount;
    let firstFramePixels = 0;
    let previous = position();
    for (let i = 0; i < 40; i++) {
      instrument(find('fill'));
      instrument(find('energy'));
      instrument(menu.effortRow);
      bundle.flushFrames(1, i % 5 === 0 ? 1000 / 30 : 1000 / 60);
      await microtasks();
      if (i === 0) firstFramePixels = position() - initial;
      assert.ok(position() + 0.001 >= previous, 'single-click animation must not reverse');
      previous = position();
    }
    const counters = { animationRenders: bundle.react.renderCount - before, backgroundWrites, shadowWrites, firstFramePixels };
    assert.equal(counters.animationRenders, 0);
    assert.equal(counters.backgroundWrites, 0);
    assert.ok(counters.shadowWrites <= 1);
    assert.ok(firstFramePixels > 1 && firstFramePixels < 172 - initial);
    assert.equal(position(), 172);
    assert.equal(menu.effortValueEl.textContent, 'Max');
    assert.equal(host.selects.length, 1);
    return counters;
  } finally {
    bundle.react.unmount();
  }
}

console.log(JSON.stringify({
  note: 'Deterministic fake-host behavior counters only; NOT browser FPS or elapsed-time benchmarks.',
  drag: await testDrag(),
  click: await testClick(),
}, null, 2));
console.log('Performance behavior tests passed.');
