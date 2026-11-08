import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createDocument, createOfficialMenu, createStore, createFakeHost, loadBundle, settle } from './harness.mjs';
const path = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const getInternals = () => loadBundle(path, createDocument()).plugin.__internals;
const efforts = ids => ids.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
const oldModel = { id: 'old', name: 'Old', reasoning: { defaultEffort: 'high', efforts: efforts(['off', 'low', 'high', 'max']) } };
const nextModel = { id: 'next', name: 'Next', reasoning: { defaultEffort: 'low', efforts: efforts(['low', 'high', 'max']) } };
function stateFor(effort = 'high') {
  return { current: { provider: 'p', model: 'old', ...(effort === undefined ? {} : { reasoningEffort: effort }) }, groups: [{ id: 'p', models: [oldModel, nextModel] }], pending: null, status: 'ready', failures: [], error: null };
}
const I = getInternals();
{
  const snapshot = stateFor();
  const input = Object.freeze({ provider: 'p', model: 'next', extra: 1 });
  assert.deepEqual(I.selectionWithRetainedEffort(snapshot, input), { provider: 'p', model: 'next', extra: 1, reasoningEffort: 'high' });
  assert.equal(input.reasoningEffort, undefined, 'caller selection is not mutated');
  assert.equal(I.selectionWithRetainedEffort(snapshot, { ...input, reasoningEffort: 'low' }).reasoningEffort, 'high', 'generated target default must not reset compatible old effort');
  for (const effort of ['max', null, '', 'unsupported-explicit']) {
    const explicit = { ...input, reasoningEffort: effort };
    assert.equal(I.selectionWithRetainedEffort(snapshot, explicit), explicit, 'non-default explicit selections are preserved');
  }
  const sameModel = { provider: 'p', model: 'old' };
  assert.equal(I.selectionWithRetainedEffort(snapshot, sameModel), sameModel, 'same-model Default action remains supported');
  assert.equal(I.selectionWithRetainedEffort({ ...snapshot, current: null }, input), input);
  assert.equal(I.selectionWithRetainedEffort({ ...snapshot, groups: [] }, input), input);
  const withDisplayName = { ...snapshot, current: { provider: 'p', model: 'old' }, retainedEffort: 'Max' };
  assert.equal(I.selectionWithRetainedEffort(withDisplayName, input).reasoningEffort, 'high', 'uses old provider default ID, not retained display name');
  const crossProvider = { ...snapshot, groups: [...snapshot.groups, { id: 'other', models: [{ ...nextModel, id: 'old' }] }] };
  assert.equal(I.selectionWithRetainedEffort(crossProvider, { provider: 'other', model: 'old' }).reasoningEffort, 'high', 'provider identity matters even with equal model ID');
  for (const target of [
    { ...nextModel, reasoning: undefined },
    { ...nextModel, reasoning: { efforts: [] } },
    { ...nextModel, reasoning: { defaultEffort: 'low', efforts: efforts(['low']) } },
  ]) {
    const state = { ...snapshot, groups: [{ id: 'p', models: [oldModel, target] }] };
    assert.equal(I.selectionWithRetainedEffort(state, input), input, 'unsupported or unknown effort must not be sent');
  }
  const offState = stateFor('off');
  offState.groups = [{ id: 'p', models: [oldModel, { ...nextModel, reasoning: { efforts: efforts(['off', 'high']) } }] }];
  assert.equal(I.selectionWithRetainedEffort(offState, input).reasoningEffort, 'off');
}
{
  const store = createStore(stateFor());
  const calls = [];
  const result = Promise.resolve({ ok: true });
  const prototype = { select(selection, additional) { calls.push({ selection, additional, receiver: this }); return result; } };
  const directory = Object.assign(Object.create(prototype), { store });
  const original = directory.select;
  const releaseA = I.retainDirectoryEffort(directory);
  const wrapped = directory.select;
  const releaseB = I.retainDirectoryEffort(directory);
  assert.equal(directory.select, wrapped, 'one wrapper per shared directory');
  const input = { provider: 'p', model: 'next' };
  assert.equal(directory.select(input, 'extra'), result, 'preserve promise identity');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, directory);
  assert.equal(calls[0].additional, 'extra');
  assert.equal(calls[0].selection.reasoningEffort, 'high');
  releaseA(); releaseA(); assert.equal(directory.select, wrapped);
  releaseB(); assert.equal(directory.select, original);
  assert.equal(Object.hasOwn(directory, 'select'), false, 'restore prototype property shape');
  const savedWrapper = wrapped;
  savedWrapper.call(directory, input);
  assert.equal(calls[1].selection, input, 'saved wrapper is pass-through after disposal');
}
{
  const store = createStore(stateFor());
  const failure = { ok: false, error: { code: 'failed', message: 'no change' } };
  let count = 0;
  const directory = { store, select() { count++; return failure; } };
  const original = directory.select;
  const release = I.retainDirectoryEffort(directory);
  assert.equal(directory.select({ provider: 'p', model: 'next' }), failure);
  assert.equal(count, 1); assert.equal(store.getSnapshot().current.model, 'old');
  release(); assert.equal(directory.select, original);
  const boom = new Error('original synchronous failure');
  directory.select = () => { throw boom; };
  const releaseThrow = I.retainDirectoryEffort(directory);
  assert.throws(() => directory.select({ provider: 'p', model: 'next' }), error => error === boom);
  releaseThrow();
  const readOnly = Object.freeze({ store, select: original });
  assert.doesNotThrow(() => I.retainDirectoryEffort(readOnly)());
  const releaseExternal = I.retainDirectoryEffort(directory);
  const replacement = () => 'external'; directory.select = replacement;
  releaseExternal(); assert.equal(directory.select, replacement);
}
{
  function directory(initial) {
    const store = createStore(initial);
    const calls = [];
    const result = {
      store, calls,
      load() { return Promise.resolve(store.getSnapshot()); },
      select(selection) {
        calls.push(selection);
        store.set({ ...store.getSnapshot(), current: { ...selection } });
        return Promise.resolve({ ok: true });
      },
    };
    return result;
  }
  const a = directory(stateFor()); const b = directory(stateFor('max'));
  const originalA = a.select; const originalB = b.select;
  let active = a;
  const access = I.createDirectoryAccess({ modelDirectories: { directoryFor: () => active } }, 'session-switch', { set: setTimeout, clear: clearTimeout });
  const first = access.getSnapshot(); assert.equal(access.getSnapshot(), first, 'stable snapshot identity');
  await a.select({ provider: 'p', model: 'next' });
  assert.equal(a.calls.length, 1); assert.equal(a.calls[0].reasoningEffort, 'high');
  assert.equal(a.store.getSnapshot().current.model, 'next');
  active = b; access.getSnapshot();
  assert.equal(a.select, originalA, 'old instance restored after directory migration');
  await b.select({ provider: 'p', model: 'next', reasoningEffort: 'low' });
  assert.equal(b.calls.length, 1); assert.equal(b.calls[0].reasoningEffort, 'max');
  access.dispose(); access.dispose(); assert.equal(b.select, originalB);
  active = a; access.getSnapshot(); assert.equal(a.select, originalA, 'disposed access never re-installs');
}
{
  const document = createDocument(); const menu = createOfficialMenu(document);
  const bundle = loadBundle(path, document); const host = createFakeHost();
  host.store.set(stateFor('max'));
  const calls = [];
  host.directory.select = async selection => {
    calls.push(selection);
    host.store.set({ ...host.store.getSnapshot(), current: { ...selection } });
    return { ok: true };
  };
  const original = host.directory.select;
  bundle.plugin.apply(host.ctx);
  bundle.react.mount(host.registered[0].Component, { sessionId: 'component-model-switch' }, menu.composer);
  await settle();
  const track = () => bundle.react.find('track');
  // Begin an uncommitted old-model preview, then invoke the same directory API used by the host model picker.
  track().fire('onPointerDown', { clientX: 14, pointerId: 1, buttons: 1 });
  bundle.flushFrames(1, 1000 / 60); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls.length, 0);
  await host.directory.select({ provider: 'p', model: 'next' });
  await settle();
  assert.equal(calls.length, 1, 'one model request, no post-switch repair request');
  assert.equal(calls[0].reasoningEffort, 'max', 'uses committed effort, never the uncommitted drag draft');
  assert.equal(host.store.getSnapshot().current.model, 'next');
  assert.equal(host.store.getSnapshot().current.reasoningEffort, 'max');
  assert.equal(menu.effortValueEl.textContent, 'Max');
  assert.equal(track().getAttribute('aria-valuetext'), 'Max');
  assert.equal(bundle.react.find('knob').style.transform, 'translate3d(172.000px,0,0)');
  track().fire('onPointerUp', {}); await settle();
  assert.equal(calls.length, 1, 'old drag cannot write to the new model');
  bundle.react.unmount(); assert.equal(host.directory.select, original);
}
console.log('Model switch tests passed: compatible IDs, generated defaults, explicit effort, one request, failure/identity, adapter migration/restoration and stale-preview isolation.');
