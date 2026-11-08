import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createDocument, createOfficialMenu, createFakeHost, loadBundle, settle } from './harness.mjs';
const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));

function fixture(options = {}) {
  const document = createDocument();
  const menu = createOfficialMenu(document, options);
  menu.menu.rect = { left: 100, top: 80, right: 400, bottom: 240, width: 300, height: 160 };
  menu.seat.rect = { left: 180, top: 260, right: 400, bottom: 288, width: 220, height: 28 };
  const bundle = loadBundle(BUNDLE, document, { reducedMotion: options.reducedMotion === true });
  const animations = [];
  let resizeCount = 0;
  bundle.window.dispatchEvent = (event) => { if (event.type === 'resize') resizeCount++; };
  bundle.window.getComputedStyle = (node) => ({ visibility: node.style.visibility || 'visible' });
  function animate(frames, timing) {
    const animation = { element: this, frames, timing, cancelled: false, onfinish: null,
      cancel() { this.cancelled = true; },
      finish() { this.onfinish?.(); },
    };
    animations.push(animation);
    return animation;
  }
  menu.menu.animate = options.throwAnimate ? () => { throw new Error('unsupported'); } : animate;
  menu.seat.animate = animate;
  menu.seatLabelEl.animate = animate;
  menu.seatEffortEl.animate = animate;
  const createElement = document.createElement;
  document.createElement = (tag) => { const node = createElement(tag); node.animate = animate; return node; };
  const presentation = bundle.plugin.__internals.createMenuPresentation({ doc: document, win: bundle.window });
  return { document, menu, bundle, presentation, animations, animate, get resizes() { return resizeCount; } };
}
function menuAnimations(f) { return f.animations.filter((a) => a.element === f.menu.menu); }

{
  const f = fixture();
  const label = f.menu.seatLabelEl;
  const effort = f.menu.seatEffortEl;
  const originalLabel = label.textContent;
  f.presentation.sync(f.menu.composer);
  const prompt = f.menu.seat.querySelector('[data-ces-part="trigger-prompt"]');
  assert.equal(prompt.textContent, '请选择模型或思考强度');
  assert.equal(prompt.getAttribute('aria-hidden'), 'true');
  assert.equal(label.textContent, originalLabel);
  assert.equal(label.parentNode, f.menu.seat);
  assert.equal(effort.textContent, 'High');
  assert.equal(label.getAttribute('data-ces-trigger-hidden'), '1');
  assert.equal(menuAnimations(f).length, 1);
  assert.equal(menuAnimations(f)[0].timing.duration, 280);
  f.menu.menu.dispatch('pointerenter', {});
  f.menu.menu.dispatch('pointermove', {});
  assert.equal(menuAnimations(f)[0].cancelled, false, 'hover must never cancel menu entrance');
  assert.equal(menuAnimations(f)[0].timing.fill, 'none');
  assert.equal(menuAnimations(f)[0].frames[0].filter, 'blur(6px)');
  assert.match(menuAnimations(f)[0].frames[0].transform, /scale\(\.86\)/);
  assert.equal(f.menu.menu.style.transformOrigin, '100% 100%');
  assert.equal(f.resizes, 1);
  for (let i = 0; i < 10; i++) f.presentation.sync(f.menu.composer);
  assert.equal(menuAnimations(f).length, 1, 'unrelated scans do not restart entrance');
  menuAnimations(f)[0].finish();
  assert.equal(f.menu.menu.getAttribute('data-ces-popover-animating'), null);
  assert.equal(f.resizes, 2, 'finish remeasures slider geometry after releasing scale');
  label.textContent = 'Updated model';
  effort.textContent = 'Max';
  f.menu.close(); f.presentation.sync(f.menu.composer);
  assert.equal(label.getAttribute('data-ces-trigger-hidden'), null);
  assert.equal(label.textContent, 'Updated model', 'closing restores current host text, not old cached text');
  assert.equal(effort.textContent, 'Max');
  const returningLabel = f.animations.find(animation => animation.element === label);
  assert.ok(returningLabel, 'current model label softly returns after selection/close');
  assert.equal(returningLabel.timing.duration, 180);
  assert.equal(returningLabel.frames[0].filter, 'blur(3px)');
  assert.equal(prompt.parentNode, null);
  assert.equal(f.menu.menu.style.transformOrigin, '');
  f.presentation.dispose();
}
{
  const f = fixture({ reasoning: false });
  f.menu.menu.setAttribute('role', 'group');
  f.presentation.sync(f.menu.composer);
  assert.equal(menuAnimations(f).length, 1, 'direct model pane works without an effort row');
  assert.ok(f.menu.seat.querySelector('[data-ces-part="trigger-prompt"]'));
  f.presentation.dispose();
}
{
  const f = fixture();
  f.menu.menu.style.visibility = 'hidden';
  f.presentation.sync(f.menu.composer);
  assert.equal(menuAnimations(f).length, 0);
  f.bundle.flushFrames(1);
  assert.equal(menuAnimations(f).length, 0, 'host measurement visibility is respected');
  f.menu.menu.style.visibility = 'visible';
  f.bundle.flushFrames(1);
  assert.equal(menuAnimations(f).length, 1);
  f.menu.menu.dispatch('pointerdown', {});
  assert.equal(menuAnimations(f)[0].cancelled, true, 'capture interaction settles scale before slider measurement');
  assert.equal(f.menu.menu.getAttribute('data-ces-popover-animating'), null);
  f.presentation.dispose();
}
{
  const f = fixture();
  f.presentation.sync(f.menu.composer);
  const oldFinish = menuAnimations(f)[0].onfinish;
  f.menu.close(); f.presentation.sync(f.menu.composer);
  f.menu.seat.setAttribute('aria-expanded', 'true');
  f.document.body.appendChild(f.menu.menu);
  f.presentation.sync(f.menu.composer);
  const count = f.resizes;
  const newAnimation = menuAnimations(f).at(-1);
  oldFinish();
  assert.equal(newAnimation.cancelled, false);
  assert.equal(f.resizes, count, 'late old animation finish cannot affect a new open cycle');
  assert.equal(f.menu.menu.getAttribute('data-ces-popover-animating'), '1');
  f.presentation.dispose();
  assert.equal(newAnimation.cancelled, true);
  assert.equal(f.menu.seat.querySelector('[data-ces-part="trigger-prompt"]'), null);
}
{
  const f = fixture();
  f.presentation.sync(f.menu.composer);
  const first = menuAnimations(f)[0];
  f.menu.menu.setAttribute('role', 'group');
  f.presentation.sync(f.menu.composer);
  assert.equal(first.cancelled, true);
  assert.equal(menuAnimations(f).at(-1).timing.duration, 200);
  f.presentation.sync(f.menu.composer);
  assert.equal(menuAnimations(f).length, 2, 'same pane updates do not reanimate');
  f.presentation.dispose();
}
for (const options of [{ reducedMotion: true }, { throwAnimate: true }]) {
  const f = fixture(options);
  f.presentation.sync(f.menu.composer);
  assert.equal(menuAnimations(f).length, options.reducedMotion ? 1 : 0);
  if (options.reducedMotion) {
    assert.equal(menuAnimations(f)[0].timing.duration, 100);
    assert.ok(menuAnimations(f)[0].frames.every(frame => !('transform' in frame) && !('filter' in frame)));
  }
  assert.equal(f.menu.menu.style.opacity, undefined);
  assert.equal(f.menu.menu.style.filter, undefined);
  assert.equal(f.menu.menu.style.transform, undefined);
  f.presentation.dispose();
  assert.equal(f.menu.seatLabelEl.getAttribute('data-ces-trigger-hidden'), null);
}
{
  const f = fixture();
  const other = createOfficialMenu(f.document);
  f.presentation.sync(f.menu.composer);
  assert.equal(other.seatLabelEl.getAttribute('data-ces-trigger-hidden'), null, 'other composer must not be modified');
  f.presentation.dispose();
}
{
  const f = fixture({ open: false });
  const anchor = f.document.createElement('span'); f.menu.composer.appendChild(anchor);
  const bridge = f.bundle.plugin.__internals.createMenuBridge({ doc: f.document, win: f.bundle.window, anchor: () => anchor, active: () => false, onChange() {} });
  bridge.start();
  const observer = f.bundle.observers.at(-1);
  f.menu.seat.setAttribute('aria-expanded', 'true');
  observer.callback([{ type: 'attributes', attributeName: 'aria-expanded', target: f.menu.seat }]);
  f.bundle.flushFrames(1);
  assert.ok(f.menu.seat.querySelector('[data-ces-part="trigger-prompt"]'), 'aria-expanded open must be observed');
  f.menu.seat.setAttribute('aria-expanded', 'false');
  observer.callback([{ type: 'attributes', attributeName: 'aria-expanded', target: f.menu.seat }]);
  f.bundle.flushFrames(1);
  assert.equal(f.menu.seat.querySelector('[data-ces-part="trigger-prompt"]'), null);
  bridge.dispose();
}
{
  const f = fixture();
  const host = createFakeHost(); f.bundle.plugin.apply(host.ctx);
  f.bundle.react.mount(host.registered[0].Component, { sessionId: 'scaled-menu-regression' }, f.menu.composer);
  await settle();
  const track = f.bundle.react.find('track');
  track.offsetWidth = 200;
  track.rect = { left: 50, top: 0, right: 222, bottom: 24, width: 172, height: 24 };
  track.fire('onPointerDown', { clientX: 50 + 186 * 0.86, pointerId: 1, buttons: 1 });
  assert.equal(f.menu.effortValueEl.textContent, 'Max', 'pointer percentage compensates for ancestor scale');
  track.fire('onPointerUp', {});
  for (let i = 0; i < 90; i++) { f.bundle.flushFrames(1, 1000 / 60); for (let j = 0; j < 10; j++) await Promise.resolve(); }
  await settle();
  assert.equal(host.store.getSnapshot().current.reasoningEffort, 'max');
  f.bundle.react.unmount();
}
{
  const f = fixture();
  function cloneTree(source) {
    const clone = f.document.createElement(source.tagName);
    for (const [key, value] of source.attributes) clone.setAttribute(key, value);
    clone.style = { ...source.style };
    if (source.children.length === 0) clone.textContent = source.textContent;
    else for (const child of source.children) clone.appendChild(cloneTree(child));
    const select = clone.querySelectorAll.bind(clone);
    clone.querySelectorAll = (selector) => {
      if (selector !== '*') return select(selector);
      const all = [];
      const walk = node => { for (const child of node.children) { all.push(child); walk(child); } };
      walk(clone); return all;
    };
    return clone;
  }
  f.menu.modelRow.setAttribute('id', 'original-model-row');
  f.menu.modelRow.setAttribute('aria-controls', 'original-controlled-panel');
  f.menu.menu.cloneNode = () => cloneTree(f.menu.menu);
  f.presentation.sync(f.menu.composer);
  menuAnimations(f)[0].finish();
  f.menu.close(); f.presentation.sync(f.menu.composer);
  const ghost = f.document.querySelector('[data-ces-menu-ghost="1"]');
  assert.ok(ghost, 'close uses a separate short-lived visual clone');
  assert.equal(ghost.inert, true);
  assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(ghost.getAttribute('id'), null);
  assert.equal(ghost.style.pointerEvents, 'none');
  const exit = f.animations.find(animation => animation.element === ghost);
  assert.equal(exit.timing.duration, 180);
  assert.match(exit.frames[1].transform, /scale\(\.86\)/);
  assert.equal(exit.frames[1].filter, 'blur(6px)');
  assert.ok(ghost.querySelectorAll('*').every(node => node.getAttribute('id') === null && node.getAttribute('aria-controls') === null));
  assert.equal(f.menu.modelRow.getAttribute('id'), 'original-model-row', 'host original is untouched');
  f.menu.seat.setAttribute('aria-expanded', 'true'); f.document.body.appendChild(f.menu.menu);
  f.presentation.sync(f.menu.composer);
  assert.equal(ghost.parentNode, null, 'reopening removes old fading snapshot');
  f.presentation.dispose();
}
{
  const f = fixture();
  f.presentation.dispose();
  let handler = null;
  let removed = false;
  const query = { matches: false, addEventListener(_event, fn) { handler = fn; }, removeEventListener(_event, fn) { removed = fn === handler; } };
  f.bundle.window.matchMedia = () => query;
  const presentation = f.bundle.plugin.__internals.createMenuPresentation({ doc: f.document, win: f.bundle.window });
  presentation.sync(f.menu.composer);
  const animation = menuAnimations(f).at(-1);
  query.matches = true; handler();
  assert.equal(animation.cancelled, true);
  assert.equal(f.menu.menu.getAttribute('data-ces-popover-animating'), null);
  presentation.dispose(); assert.equal(removed, true);
}
{
  const f = fixture();
  f.menu.menu.style.visibility = 'hidden';
  f.presentation.sync(f.menu.composer);
  f.bundle.flushFrames(12);
  assert.equal(menuAnimations(f).length, 0);
  f.menu.menu.style.visibility = 'visible';
  const readyObserver = f.bundle.observers.find(item => item.targets.includes(f.menu.menu));
  readyObserver.callback([{ type: 'attributes', attributeName: 'style', target: f.menu.menu }]);
  assert.equal(menuAnimations(f).length, 1, 'visibility starts animation even with a queued or throttled frame');
  f.bundle.flushFrames(1);
  assert.equal(menuAnimations(f).length, 1, 'hidden longer than eight frames must still animate when shown');
  f.presentation.dispose();
}
{
  const f = fixture();
  f.menu.menu.style.visibility = 'hidden';
  f.presentation.sync(f.menu.composer);
  f.bundle.flushFrames(125);
  assert.equal(menuAnimations(f).length, 0);
  f.menu.menu.style.visibility = 'visible';
  const observer = f.bundle.observers.find(item => item.targets.includes(f.menu.menu));
  assert.ok(observer, 'a menu-scoped visibility observer is installed');
  observer.callback([{ type: 'attributes', attributeName: 'style', target: f.menu.menu }]);
  assert.equal(menuAnimations(f).length, 1, 'visibility observer rearms an entrance after the bounded frame wait');
  f.presentation.sync(f.menu.composer);
  assert.equal(menuAnimations(f).length, 1);
  f.presentation.dispose();
  assert.equal(observer.targets.length, 0);
}
{
  const f = fixture();
  f.menu.seat.rect.width = 140;
  const readStyle = f.bundle.window.getComputedStyle;
  f.bundle.window.getComputedStyle = node => node === f.menu.seat
    ? { width: node.querySelector('[data-ces-part="trigger-prompt"]') ? '220px' : '140px' }
    : readStyle(node);
  f.presentation.sync(f.menu.composer);
  const copies = f.document.querySelectorAll('[data-ces-trigger-copy="1"]');
  assert.equal(copies.length, 2, 'outgoing model and effort remain as non-interactive visual copies');
  assert.ok(copies.every(node => node.inert && node.getAttribute('aria-hidden') === 'true'));
  assert.ok(copies.every(node => node.style.pointerEvents === 'none'));
  const leaving = f.animations.filter(animation => copies.includes(animation.element));
  assert.ok(leaving.every(animation => animation.frames[0].opacity === 1 && animation.frames[1].opacity === 0));
  const width = f.animations.find(animation => animation.element === f.menu.seat);
  assert.equal(width, undefined, 'text uses final natural width from the first frame, never a width-reveal animation');
  const prompt = f.menu.seat.querySelector('[data-ces-part="trigger-prompt"]');
  const entering = f.animations.find(animation => animation.element === prompt);
  assert.equal(entering.frames[0].opacity, 0);
  assert.equal(entering.frames[1].opacity, 1);
  f.menu.close(); f.presentation.sync(f.menu.composer);
  assert.ok(copies.every(node => node.parentNode === null));
  const returningCopies = f.document.querySelectorAll('[data-ces-trigger-copy="1"]');
  assert.equal(returningCopies.length, 1);
  assert.equal(returningCopies[0].textContent, '请选择模型或思考强度');
  assert.ok(f.animations.some(animation => animation.element === f.menu.seatLabelEl && animation.frames[0].opacity === 0));
  const returnWidth = f.animations.filter(animation => animation.element === f.menu.seat).at(-1);
  assert.equal(returnWidth, undefined, 'returning model label must not be progressively clipped either');
  f.presentation.dispose();
  assert.equal(f.document.querySelectorAll('[data-ces-trigger-copy="1"]').length, 0);
  assert.ok(f.animations.every(animation => animation.frames.every(frame => !('width' in frame))), 'all text transitions animate whole phrases');
}
console.log('Menu presentation tests passed: prompt preservation, scoped animation, pane changes, cancellation, reduced motion, attributes, scaled interaction and inert exit snapshots.');
