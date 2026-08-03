/* DOM mínimo para exercitar os renderizadores fora do browser */
class Ctx {
  constructor(){ this.calls=0; }
  setTransform(){} save(){} restore(){} translate(){} rotate(){} scale(){} beginPath(){} closePath(){} clip(){} rect(){}
  moveTo(){} lineTo(){} arc(){} stroke(){} fill(){} fillRect(){} strokeRect(){}
  setLineDash(){} drawImage(){} measureText(t){return {width:String(t).length*6};}
  fillText(){this.calls++;} createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};}
  putImageData(){}
}
class Canvas {
  constructor(){ this.style={}; this.width=600; this.height=300; this._ctx=new Ctx(); this.attrs={}; }
  setAttribute(k,v){ this.attrs[k]=v; } getAttribute(k){ return this.attrs[k]; } removeAttribute(k){ delete this.attrs[k]; }
  getContext(){ return this._ctx; }
  addEventListener(){} removeEventListener(){}
  get parentNode(){ return this._parent || null; }
  getBoundingClientRect(){ return {width:600,height:300}; }
  toDataURL(){ return 'data:,'; }
}
class Node {
  constructor(tag){ this.tagName=(tag||'div').toUpperCase(); this.children=[]; this.style={}; this.className='';
    this.clientWidth=600; this._text=''; this.attrs={}; }
  appendChild(n){ this.children.push(n); return n; }
  addEventListener(){} setAttribute(k,v){ this.attrs[k]=v; } removeAttribute(){}
  getBoundingClientRect(){ return {width:600,height:300}; }
  set textContent(v){ this._text=v; } get textContent(){ return this._text; }
  set innerHTML(v){ this._html=v; } get innerHTML(){ return this._html||''; }
  get clientHeight(){ return 300; }
  classList={add(){},remove(){},contains(){return false;}};
  querySelector(){ return null; }
}
export function installDOM(){
  /* nós por id são ESTÁVEIS: o painel de processamento escreve em #procPct,
     #procNow etc. e os testes precisam ler de volta o que foi escrito */
  const porId = new Map();
  const doc = {
    createElement(tag){ return tag==='canvas' ? new Canvas() : new Node(tag); },
    createTextNode(t){ const n=new Node('#text'); n._text=t; return n; },
    querySelector(){ return new Node('div'); },
    querySelectorAll(){ return []; },
    addEventListener(){},
    getElementById(id){
      if(!porId.has(id)) porId.set(id, new Node('div'));
      return porId.get(id);
    }
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.devicePixelRatio = 1;
  globalThis.Blob = class { constructor(){} };
  globalThis.URL = { createObjectURL(){return 'blob:';}, revokeObjectURL(){} };
  globalThis.alert = m => { throw new Error('alert: '+m); };
  try{ Object.defineProperty(globalThis,"navigator",{value:{serviceWorker:null},configurable:true}); }catch(e){}
  globalThis.location = { protocol:'file:' };
  return doc;
}
