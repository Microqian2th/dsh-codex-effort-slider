import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {createDocument,createOfficialMenu,createFakeHost,loadBundle,settle} from './harness.mjs';
const path = fileURLToPath(new URL('../lib/client.js', import.meta.url));
async function microtasks(){for(let i=0;i<8;i++)await Promise.resolve();}
{
 const document=createDocument(), menu=createOfficialMenu(document), bundle=loadBundle(path,document);
 const anchor=document.createElement('span');menu.composer.appendChild(anchor);
 let current=null;
 const bridge=bundle.plugin.__internals.createMenuBridge({doc:document,win:bundle.window,anchor:()=>anchor,active:()=>true,onChange:host=>{current=host;}});
 bridge.start();assert.ok(current);
 const observer=bundle.observers.at(-1);
 // Removing the root pane detaches our row. The menu surface itself survives.
 menu.menu.removeChild(menu.modelRow);menu.menu.removeChild(menu.effortRow);
 observer.callback([{target:menu.menu,addedNodes:[],removedNodes:[menu.modelRow,menu.effortRow]}]);
 bundle.flushFrames();assert.equal(current,null);
 menu.menu.appendChild(menu.modelRow);menu.menu.appendChild(menu.effortRow);
 observer.callback([{target:menu.menu,addedNodes:[menu.modelRow,menu.effortRow],removedNodes:[]}]);
 assert.equal(bundle.flushFrames(),1);assert.ok(current,'same menu surface must reinject root slider');
 // Multiple related changes coalesce to a single frame, and plugin DOM is excluded.
 observer.callback([{target:current.container,addedNodes:[],removedNodes:[]}]);
 assert.equal(bundle.flushFrames(),0,'own portal changes must be ignored');
 observer.callback([{target:menu.menu,addedNodes:[],removedNodes:[]}]);
 observer.callback([{target:menu.menu,addedNodes:[],removedNodes:[]}]);
 assert.equal(bundle.flushFrames(3),1,'related callbacks must coalesce');
 const outside=document.createElement('div');document.body.appendChild(outside);
 observer.callback([{target:outside,addedNodes:[],removedNodes:[]}]);
 assert.equal(bundle.flushFrames(),0,'unrelated conversation changes must not scan');
 bridge.dispose();assert.equal(current,null);
}
{
 const document=createDocument(),menu=createOfficialMenu(document),bundle=loadBundle(path,document),host=createFakeHost();
 const listeners=new Map();
 bundle.window.addEventListener=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);};
 bundle.window.removeEventListener=(name,fn)=>listeners.get(name)?.delete(fn);
 bundle.plugin.apply(host.ctx);bundle.react.mount(host.registered[0].Component,{sessionId:'geometry-regression'},menu.composer);await settle();
 const track=()=>bundle.react.find('track');const knob=()=>bundle.react.find('knob');
 track().fire('onPointerDown',{clientX:14+0.76*172,pointerId:1,buttons:1});
 bundle.flushFrames(1,16.67);await microtasks();
 track().rect={left:40,width:240,top:0,bottom:28,height:28,right:280};
 for(const fn of listeners.get('scroll')??[])fn();
 const before=knob().style.transform;
 for(let i=0;i<4;i++){bundle.flushFrames(1,16.67);await microtasks();}
 assert.notEqual(knob().style.transform,before,'scroll must not freeze an in-flight animation');
 assert.equal(bundle.react.find('fill').style.width,'100%');
 assert.ok(bundle.react.find('fill').style.background.startsWith('linear-gradient('),'fill must retain a static positional gradient');
 track().fire('onPointerUp',{});
 for(let i=0;i<90;i++){bundle.flushFrames(1,16.67);await microtasks();}
 bundle.react.unmount();
}
console.log('Lifecycle regression: same-menu pane return, observer filtering/coalescing, scroll repaint and static gradient passed.');
