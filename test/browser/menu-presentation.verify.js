if (new URLSearchParams(location.search).has('verify-regression')) (async () => {
  const checks = [];
  const check = (name, condition) => { checks.push({ name, pass: !!condition }); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    open();
    let entrance = menu.getAnimations().find(a => a.effect.getKeyframes().some(f => String(f.transform).includes('scale')));
    check('native entrance created', entrance);
    entrance.pause(); entrance.currentTime = 90;
    menu.dispatchEvent(new PointerEvent('pointerenter'));
    menu.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    check('hover keeps entrance alive', entrance.playState !== 'idle' && menu.getAnimations().includes(entrance));
    check('mid-entrance blur exists', parseFloat(getComputedStyle(menu).filter.replace(/[^\d.]/g,'')) > 0);
    const copies = [...document.querySelectorAll('[data-ces-trigger-copy="1"]')];
    check('outgoing model effort snapshots exist', copies.length === 2);
    for (const copy of copies) { const animation=copy.getAnimations()[0]; animation.pause(); animation.currentTime=75; }
    const prompt = trigger.querySelector('[data-ces-part="trigger-prompt"]');
    const promptAnimation = prompt.getAnimations()[0]; promptAnimation.pause(); promptAnimation.currentTime=75;
    const outgoingOpacity = copies.length ? parseFloat(getComputedStyle(copies[0]).opacity) : NaN;
    const incomingOpacity = parseFloat(getComputedStyle(prompt).opacity);
    check('outgoing model text actually fades', outgoingOpacity > 0 && outgoingOpacity < 1);
    check('incoming prompt actually fades', incomingOpacity > 0 && incomingOpacity < 1);
    const width = trigger.getAnimations().find(a => a.effect.getKeyframes().some(f => f.width));
    check('button never width-reveals the phrase', !width);
    const fullWidths = [];
    const tail = document.createRange(); tail.setStart(prompt.firstChild, prompt.textContent.length - 1); tail.setEnd(prompt.firstChild, prompt.textContent.length);
    let lastGlyphVisible = true;
    for (const time of [0, 40, 90, 150, 210]) {
      promptAnimation.currentTime = time;
      const rect = prompt.getBoundingClientRect();
      fullWidths.push(rect.width);
      const end = tail.getBoundingClientRect();
      lastGlyphVisible = lastGlyphVisible && end.right <= rect.right + 1 && prompt.scrollWidth <= prompt.clientWidth + 1;
    }
    check('full prompt width is constant throughout fade', Math.max(...fullWidths) - Math.min(...fullWidths) < 0.5);
    check('last character fits at every fade sample', lastGlyphVisible);
    for (const a of document.getAnimations()) a.finish();
    await wait(10);
    close();
    const outgoingPrompt = document.querySelector('[data-ces-trigger-copy="1"]');
    check('closing keeps outgoing prompt snapshot', outgoingPrompt?.textContent === '请选择模型或思考强度');
    const returned = trigger.querySelector('.triggerLabel').getAnimations()[0];
    check('real model text softly returns', returned);
    if (returned) { returned.pause(); returned.currentTime=70; }
    if (outgoingPrompt) { const a=outgoingPrompt.getAnimations()[0]; a.pause(); a.currentTime=70; }
    check('return text is partially visible', returned && parseFloat(getComputedStyle(trigger.querySelector('.triggerLabel')).opacity) > 0 && parseFloat(getComputedStyle(trigger.querySelector('.triggerLabel')).opacity) < 1);
    for (const a of document.getAnimations()) a.finish();
    await wait(300);
    check('no outgoing text snapshot remains', document.querySelectorAll('[data-ces-trigger-copy="1"]').length === 0);
    check('no menu ghost remains', document.querySelector('[data-ces-menu-ghost="1"]') === null);
    // Reproduce the real host's hidden measurement period lasting longer than the previous eight-frame limit.
    menu = document.createElement('div'); menu.id='demo-menu'; menu.className='menu'; menu.setAttribute('role','menu');
    menu.style.visibility='hidden'; menu.innerHTML='<button role="menuitem">模型</button><button role="menuitem">思考强度</button>';
    document.body.appendChild(menu); trigger.setAttribute('aria-expanded','true'); trigger.setAttribute('aria-controls',menu.id);
    presentation.sync(composer);
    await wait(230);
    check('measurement-hidden menu not forced visible', getComputedStyle(menu).visibility==='hidden');
    menu.style.visibility='visible';
    await wait(35);
    const delayed = menu.getAnimations().find(a=>a.effect.getKeyframes().some(f=>String(f.transform).includes('scale')));
    check('delayed visible menu still animates', delayed && delayed.playState !== 'idle');
    close(); await wait(300); presentation.dispose();
  } catch (error) { checks.push({ name: 'exception', pass:false, error:String(error.stack||error) }); }
  const result=document.createElement('pre'); result.id='entrance-crossfade-verification';
  result.textContent=JSON.stringify({result: checks.every(item=>item.pass)?'PASS':'FAIL',checks},null,2);
  document.body.appendChild(result);
})();
