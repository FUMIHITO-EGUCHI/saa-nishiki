export const tr=(ja,en)=>globalThis.globalSettings?.language==='ja-JP'?ja:en;
export function element(tag,text='',className='') {const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;}
export function button(text,action,id) {const node=element('button',text);node.type='button';if(id)node.id=id;node.addEventListener('click',action);return node;}
export function field(parent,text,input) {const label=element('label',text,'workflow-field');label.append(input);parent.append(label);return input;}
export function select(options,value) {const node=document.createElement('select');for(const item of options){const option=element('option',typeof item==='string'?item:item.label);option.value=typeof item==='string'?item:item.value;node.append(option);}if(value!==undefined)node.value=value;return node;}
export function number(parent,label,value,min,max,step=1) {const input=document.createElement('input');input.type='number';Object.assign(input,{value:String(value),min:String(min),max:String(max),step:String(step)});return field(parent,label,input);}
export const readFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
export function image(src,alt) {const node=element('img');node.src=src;node.alt=alt;return node;}
