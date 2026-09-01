'use strict';
// 只验证图表构造与安全格式化，不伪装成浏览器像素测试。
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const errors=[],nodes={},options={};
const context={console:{log(){},warn(){},error(...items){errors.push(items.map(String).join(' '));}},
 document:{documentElement:{},getElementById(id){return nodes[id]||(nodes[id]={id,style:{}});}},
 getComputedStyle(){return {getPropertyValue(){return '';}};},
 echarts:{init(node){return {setOption(option){options[node.id]=option;},on(){},off(){},resize(){},dispose(){}};}}};
context.window=context;vm.createContext(context);
for(const file of ['store','attendance','metrics','charts'])vm.runInContext(fs.readFileSync(__dirname+'/../web/js/'+file+'.js','utf8'),context);
const raw=JSON.parse(fs.readFileSync(process.argv[2]||__dirname+'/../data/checkin_data.json','utf8'));
context.Store.ingest(raw);context.Store.setRange('all');context.Charts.renderAll();
context.Charts.person(raw.users[0].userid);
assert.deepEqual(errors,[],'全部图表构造不应有运行错误');
assert(Object.keys(options).length>=30);
const html=options.c_scatterTime.tooltip.formatter({value:[540,1200,'<img src=x onerror="alert(1)">','2026-08-03','测试部门',0]});
assert(!html.includes('<img'));assert(html.includes('&lt;img'));
context.Store.filters.dept='不存在';context.Store.applyFilters();context.Charts.renderAll();
assert.deepEqual(errors,[],'空筛选图表不应崩溃');
console.log('图表构造冒烟通过：'+Object.keys(options).length+' 个图表、空筛选与tooltip转义');
