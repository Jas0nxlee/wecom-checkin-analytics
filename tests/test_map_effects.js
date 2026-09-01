'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const effects=require('../web/js/map-effects.js');
let passed=0;
function test(name,fn){fn();passed++;console.log('  ✓ '+name);}
function near(a,b,epsilon=1e-5){assert(Math.abs(a-b)<=epsilon,`${a} != ${b}`);}
test('空数据和无效坐标不生成热点',()=>{
 for(const points of [[],[{x:NaN,y:1}],[{x:1,y:1,weight:0}],[{x:1,y:1,weight:-1}]]){
  const d=effects.density(points,120,80,24);assert.equal(d.max,0);assert(effects.colorize(d).every(x=>x===0));
 }
 assert.equal(effects.density([],0,0,24).values.length,0);
});
test('浮点密度不会像透明度叠加一样饱和',()=>{
 const one=effects.density([{x:120,y:90,weight:1}],240,180,24);
 const many=effects.density([{x:120,y:90,weight:10000}],240,180,24);
 near(many.max/one.max,10000,.02);
});
test('重复点和等权重聚合一致，输入不被修改',()=>{
 const points=Array.from({length:20},()=>({x:120.3,y:90.6,weight:1})),before=JSON.stringify(points);
 const one=effects.density([{x:120.3,y:90.6,weight:20}],240,180,24),many=effects.density(points,240,180,24);
 near(one.max,many.max);assert.equal(JSON.stringify(points),before);
});
test('热核满饱和、边缘渐隐且色带过渡平滑',()=>{
 const d=effects.density([{x:120,y:90,weight:1}],240,180,24),rgba=effects.colorize(d);
 const y=Math.floor(d.height/2),alphas=[];
 for(let x=Math.floor(d.width/2);x<d.width;x++)alphas.push(rgba[(y*d.width+x)*4+3]);
 assert.equal(alphas[0],255);assert.equal(alphas[alphas.length-1],0);
 assert(new Set(alphas).size>20);
 assert(Math.max(...alphas.slice(1).map((v,i)=>Math.abs(v-alphas[i])))<20);
});
test('视野外近邻热点尾部仍能进入视口',()=>{
 assert(effects.density([{x:-12,y:90}],240,180,24).max>0);
 assert.equal(effects.density([{x:-5000,y:90}],240,180,24).max,0);
});
test('蓝色密度不出现彩色分层，透明度与彩色热力一致',()=>{
 const d=effects.density([{x:80,y:60,weight:12},{x:120,y:80,weight:3}],240,180,24);
 const blue=effects.colorize(d,true),heat=effects.colorize(d,false);
 for(let i=0;i<blue.length;i+=4){assert.equal(blue[i+3],heat[i+3]);if(blue[i+3])assert.deepEqual(Array.from(blue.slice(i,i+3)),[47,111,237]);}
});
test('提高柔化程度降低峰值并扩大扩散',()=>{
 const points=[{x:180,y:150,weight:100}],small=effects.density(points,360,300,18),large=effects.density(points,360,300,48);
 assert(large.max<small.max);assert(large.values.filter(x=>x>1e-7).length>small.values.filter(x=>x>1e-7).length);
});
test('触摸板微小事件不会每次跳一级',()=>{
 const state={};let steps=0;
 for(let i=0;i<50;i++)steps+=Math.abs(effects.wheelStep(state,{deltaY:2},i*10));
 assert.equal(steps,0);assert.equal(effects.wheelStep(state,{deltaY:20},510),-1);
});
test('单次大滚轮事件最多一级，连续事件受冷却约束',()=>{
 const state={};assert.equal(effects.wheelStep(state,{deltaY:-10000},0),1);
 assert.equal(effects.wheelStep(state,{deltaY:-10000},100),0);
 assert.equal(effects.wheelStep(state,{deltaY:-120},241),1);
});
test('方向反转与停顿都会清理未触发的累计量',()=>{
 const state={};assert.equal(effects.wheelStep(state,{deltaY:100},0),0);
 assert.equal(effects.wheelStep(state,{deltaY:-60},40),0);assert.equal(effects.wheelStep(state,{deltaY:-60},80),1);
 const idle={};effects.wheelStep(idle,{deltaY:100},0);assert.equal(effects.wheelStep(idle,{deltaY:30},250),0);
});
test('支持滚轮行单位、页单位与触摸板捏合',()=>{
 assert.equal(effects.wheelStep({},{deltaY:3,deltaMode:1},0),-1);
 assert.equal(effects.wheelStep({},{deltaY:-1,deltaMode:2},0,520),1);
 const state={};assert.equal(effects.wheelStep(state,{deltaY:-20,ctrlKey:true},0),0);assert.equal(effects.wheelStep(state,{deltaY:-30,ctrlKey:true},30),1);
 assert.equal(effects.wheelStep({},{deltaY:NaN},0),0);assert.equal(effects.wheelStep({},{deltaY:0},0),0);
});
const ctx={window:{MapEffects:effects}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(__dirname+'/../web/js/map.js','utf8'),ctx);
function map(){const view=Object.create(ctx.window.MapView.prototype);Object.assign(view,{w:800,h:520,zoom:12,center:{lat:30,lng:120},tilesOff:false,render(){}});return view;}
test('缩放锚点保持在鼠标下，在线与离线一致',()=>{
 for(const offline of [false,true]){const m=map();m.tilesOff=offline;const p={lat:30.02,lng:120.03},before=m.project(p);assert(m.zoomAt(1,before.x,before.y));const after=m.project(p);near(before.x,after.x);near(before.y,after.y);}
});
test('最大最小级别不越界',()=>{const m=map();m.zoom=18;assert.equal(m.zoomAt(1,400,260),false);m.zoom=3;assert.equal(m.zoomAt(-1,400,260),false);});
test('实际滚轮绑定使用累计阈值和鼠标锚点',()=>{
 const handlers={},calls=[];let now=0,prevented=0;
 const m=map();m.wheelState={};m.el={addEventListener(name,fn,options){handlers[name]=fn;if(name==='wheel')assert.equal(options.passive,false);},getBoundingClientRect(){return {left:40,top:60};}};
 m.zoomAt=(...args)=>calls.push(args);ctx.window.addEventListener=()=>{};ctx.Date={now:()=>now};m.bind();
 const event={deltaY:-20,clientX:140,clientY:180,preventDefault(){prevented++;}};
 handlers.wheel(event);assert.equal(calls.length,0);now=20;handlers.wheel({...event,deltaY:-100});assert.deepEqual(calls,[[1,100,120]]);
 now=40;handlers.wheel({...event,deltaY:-400});assert.equal(calls.length,1);assert.equal(prevented,3);
});
test('两种密度模式走真实绘制路径，换色复用密度，移动失效',()=>{
 let computations=0,draws=0;
 ctx.window.MapEffects={...effects,density(...args){computations++;return effects.density(...args);}};
 ctx.document={createElement(){return {getContext(){return {createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(img){assert(img.data.some(x=>x>0));}};}};}};
 const m=map();m.mode='heat';m.heatSpread=30;m.points=[{lat:30,lng:120,weight:100}];m.ctx={save(){},restore(){},drawImage(){draws++;}};
 m.drawHeat();m.mode='density';m.drawHeat();assert.equal(computations,1);assert.equal(draws,2);
 m.center.lng+=.001;m.drawHeat();assert.equal(computations,2);
});
test('热力模式不再绘制锚点和规则范围',()=>{assert.equal(ctx.window.MapView.prototype.drawRadius,undefined);assert.equal(ctx.window.MapView.prototype.drawAnchors,undefined);assert(!fs.readFileSync(__dirname+'/../web/index.html','utf8').includes('id="mapRadius"'));});
console.log('地图视觉与缩放测试：'+passed+' 项通过');
