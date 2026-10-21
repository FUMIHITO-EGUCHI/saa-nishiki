export function imagePoint(event, rect, width, height) {
    return {x:Math.max(0,Math.min(width-1,(event.clientX-rect.left)*width/rect.width)),
        y:Math.max(0,Math.min(height-1,(event.clientY-rect.top)*height/rect.height))};
}
const loadImage=src=>new Promise((resolve,reject)=> {const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Image could not be decoded'));image.src=src;});

export async function createMaskCanvas(container, src, width, height, onChange=()=>{}) {
    const surface=document.createElement('div');surface.className='edit-canvas-surface';
    const image=document.createElement('img');image.alt='Parent / candidate comparison';image.draggable=false;image.src=src;
    const overlay=document.createElement('canvas');overlay.width=width;overlay.height=height;overlay.tabIndex=0;
    overlay.setAttribute('aria-label','Paint edit or Lock mask. Mask PNG files can also be imported.');
    surface.append(image,overlay);container.append(surface);
    const make=()=> {const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;};
    const edit=make(), lock=make(), tinted=make();
    let tool='edit',brush=32,drawing=false,last=null,visible=true,permission=null;
    const context=overlay.getContext('2d');
    function tint(canvas,color) {
        const ctx=tinted.getContext('2d');ctx.clearRect(0,0,width,height);ctx.drawImage(canvas,0,0);
        ctx.globalCompositeOperation='source-in';ctx.fillStyle=color;ctx.fillRect(0,0,width,height);ctx.globalCompositeOperation='source-over';
        context.drawImage(tinted,0,0);
    }
    function render() {context.clearRect(0,0,width,height);if(visible){tint(permission??edit,'rgba(52,211,153,0.48)');tint(lock,'rgba(251,191,36,0.7)');}}
    function stroke(point) {
        const target=tool.toLowerCase().includes('lock')?lock:edit;
        const ctx=target.getContext('2d');ctx.globalCompositeOperation=tool.startsWith('erase')?'destination-out':'source-over';
        ctx.strokeStyle='white';ctx.fillStyle='white';ctx.lineWidth=brush;ctx.lineCap='round';ctx.lineJoin='round';
        ctx.beginPath();ctx.moveTo(last?.x??point.x,last?.y??point.y);ctx.lineTo(point.x,point.y);ctx.stroke();
        if(!last){ctx.beginPath();ctx.arc(point.x,point.y,brush/2,0,Math.PI*2);ctx.fill();}
        ctx.globalCompositeOperation='source-over';last=point;permission=null;render();onChange();
    }
    overlay.addEventListener('pointerdown',event=> {if(event.button!==0)return;event.preventDefault();overlay.setPointerCapture(event.pointerId);drawing=true;last=null;stroke(imagePoint(event,overlay.getBoundingClientRect(),width,height));});
    overlay.addEventListener('pointermove',event=> {if(drawing)stroke(imagePoint(event,overlay.getBoundingClientRect(),width,height));});
    const end=()=>{drawing=false;last=null;};overlay.addEventListener('pointerup',end);overlay.addEventListener('pointercancel',end);
    const exportMask=canvas=> {const copy=make(),ctx=copy.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,width,height);ctx.drawImage(canvas,0,0);return copy.toDataURL('image/png');};
    async function importMask(canvas,data,merge=false) {
        const imported=await loadImage(data);
        if(imported.naturalWidth!==width||imported.naturalHeight!==height)throw new Error('Mask dimensions must match the parent image');
        const copy=make(),ctx=copy.getContext('2d');ctx.drawImage(imported,0,0);const pixels=ctx.getImageData(0,0,width,height);
        for(let i=0;i<pixels.data.length;i+=4){pixels.data[i+3]=pixels.data[i];pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;}
        ctx.putImageData(pixels,0,0);const dest=canvas.getContext('2d');if(!merge)dest.clearRect(0,0,width,height);dest.drawImage(copy,0,0);render();
    }
    function zoom(value) {surface.style.width=`${width*value}px`;surface.style.height=`${height*value}px`;}
    zoom(Math.min(1,640/width));
    return {
        masks:()=>({mask:exportMask(edit),lock:exportMask(lock)}),
        setTool:value=>{tool=value;}, setBrush:value=>{brush=value;}, zoom,
        setImage:async value=>{await loadImage(value);image.src=value;},
        showMasks:value=>{visible=value;render();},
        clear:which=>{(which==='lock'?lock:edit).getContext('2d').clearRect(0,0,width,height);permission=null;render();onChange();},
        importEdit:async data=>{await importMask(edit,data);permission=null;render();onChange();},
        importLock:async (data,merge=false)=>{await importMask(lock,data,merge);permission=null;render();onChange();},
        permission:async data=>{permission=make();if(data)await importMask(permission,data);render();},
    };
}
