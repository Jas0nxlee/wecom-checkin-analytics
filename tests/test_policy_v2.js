/* 与现有快照无关的独立反例；预期数值按业务定义直接给定。 */
'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const context={console};context.window=context;vm.createContext(context);
for(const file of ['store','attendance','metrics'])vm.runInContext(fs.readFileSync(__dirname+'/../web/js/'+file+'.js','utf8'),context);
const S=context.Store,M=context.Metrics;let count=0;
function test(name,fn){fn();count++;console.log('  ✓ '+name);}
function record(uid,date,min,type='上班打卡',exception=''){
 return {userid:uid,name:uid,dept:'旧部门',date,attendance_date:date,ts:Date.parse(date+'T00:00:00+08:00')/1000+min*60,
  minute_of_day:min,hour:Math.floor(min/60),type,exception,lat:30,lng:120,location_title:'测试办公室',groupname:'固定班'};
}
function daily(uid,date,patch={}){return Object.assign({userid:uid,date,dept:'旧部门',groupname:'固定班',day_type:0,schema_version:2,
  segments:[{work_sec:32400,off_work_sec:43200},{work_sec:46800,off_work_sec:64800}],std_work_min:540,std_off_min:1080,
  checkin_count:2,actual_work_sec:28800,standard_work_sec:28800,earliest_min:540,lastest_min:1200,exceptions:{},ot_sec:99999,
  fetched_at:'2026-08-31T12:00:00+08:00'},patch);}
function payload(records=[],dailyRows=[],users=['a','b'],extra={}){return Object.assign({meta:{start:'2026-08-03',end:'2026-08-03'},
  records,daily:dailyRows,users:users.map(userid=>({userid,name:userid,main_dept:userid==='a'?'当前A部':'当前B部'})),rules:[],approvals:[],monthly:[]},extra);}
function load(p){S.ingest(p);S.setRange('all');return M.agg(M.days());}
const baseRecords=[record('a','2026-08-03',540),record('a','2026-08-03',1200,'下班打卡')];
test('两人只有一人出勤：分母保留无记录员工，出勤50%',()=>{
 const a=load(payload(baseRecords,[daily('a','2026-08-03'),daily('b','2026-08-03',{checkin_count:0,actual_work_sec:0,earliest_min:0,lastest_min:0,exceptions:{'旷工':{count:1,duration:28800}}})]));
 assert.equal(a.headcount,2);assert.equal(a.expPersonDays,2);assert.equal(a.personDays,1);assert.equal(a.attendanceRate,.5);assert.equal(a.absent,1);
});
test('全日未打卡占位不会变成实际出勤',()=>{
 const a=load(payload([record('a','2026-08-03',540,'上班打卡','未打卡'),record('a','2026-08-03',1080,'下班打卡','未打卡')],[daily('a','2026-08-03',{checkin_count:0,actual_work_sec:0,exceptions:{'旷工':{count:1}}})],['a']));
 assert.equal(a.attendanceRate,0);assert.equal(a.punches,0);assert.equal(a.otSec,0);
});
test('官方工时0不能覆盖；19点后工时独立于审批加班',()=>{
 const a=load(payload(baseRecords,[daily('a','2026-08-03',{actual_work_sec:0})],['a']));
 assert.equal(a.workSec,0);assert.equal(a.avgWorkHours,0);assert.equal(a.otSec,3600);
});
test('20点到岗22点离岗只算2小时，不从19点算3小时',()=>{
 const a=load(payload([record('a','2026-08-03',1200),record('a','2026-08-03',1320,'下班打卡')],[daily('a','2026-08-03',{earliest_min:1200,lastest_min:1320})],['a']));assert.equal(a.otSec,7200);
});
test('19点之前离岗加班为零',()=>{const a=load(payload(baseRecords,[daily('a','2026-08-03',{lastest_min:1080})],['a']));assert.equal(a.otSec,0);});
test('只有单卡且未补正不能捏造晚间跨度',()=>{const a=load(payload([record('a','2026-08-03',1320)],[daily('a','2026-08-03',{checkin_count:1,earliest_min:1320,lastest_min:1320})],['a']));assert.equal(a.otSec,0);assert.equal(a.otUnknownDays,1);});
test('一天缺卡2次，各页都是100%人日率而非200%',()=>{
 load(payload(baseRecords,[daily('a','2026-08-03',{exceptions:{'缺卡':{count:2,duration:0}}})],['a']));
 assert.equal(M.agg(M.days()).missRate,1);assert.equal(M.dailySeries()[0].missRate,1);assert.equal(M.deptCompare()[0].missRate,1);assert.equal(M.monthCompare()[0].missRate,1);
});
test('星期日调班按企业微信日报算工作日',()=>{let p=payload([], [daily('a','2026-08-02')],['a'],{meta:{start:'2026-08-02',end:'2026-08-02'}});assert.equal(load(p).expPersonDays,1);});
test('星期一休息按企业微信日报计算，不按星期推翻',()=>{const a=load(payload([], [daily('a','2026-08-03',{day_type:1,checkin_count:0,actual_work_sec:0})],['a']));assert.equal(a.expPersonDays,0);assert.equal(a.attendanceRate,null);});
test('部分排班未知不隐藏核定出勤率，人员和缺口保留',()=>{const a=load(payload(baseRecords,[daily('a','2026-08-03')]));assert.equal(a.headcount,2);assert.equal(a.unknownSchedule,1);assert.equal(a.attendanceRate,1);assert.equal(a.ratePersonDays,1);assert.equal(a.rateMissingPersonDays,1);assert.equal(a.dataCoverageRate,.5);assert.equal(a.ratePartial,true);});
test('已知排班但缺日报不得伪造最终比率或工时',()=>{const a=load(payload(baseRecords,[],['a'],{rules:[{userid:'a',date:'2026-08-03',expected:true}]}));assert.equal(a.attendanceRate,null);assert.equal(M.days()[0].workSec,null);});
test('补卡后原始地点异常仍保留，当前异常地图必须清零',()=>{
 const approval={approval_no:'fake',userid:'a',date:'2026-08-03',status:'approved',correction_ts:1785720000,apply_time:10,fetched_at:'2026-08-31T11:00:00+08:00'};
 load(payload([record('a','2026-08-03',540,'上班打卡','地点异常')],[daily('a','2026-08-03',{sp_items:[{type:'补卡',count:1}]})],['a'],{approvals:[approval]}));
 assert.equal(M.geoRecords('exc').length,0);assert.equal(M.geoRecords('raw_exc').length,1);assert.equal(M.days()[0].correctionStatus,'corrected');
});
test('待审批不提前消除异常',()=>{
 load(payload(baseRecords,[daily('a','2026-08-03',{exceptions:{'地点异常':{count:1}}})],['a'],{approvals:[{userid:'a',date:'2026-08-03',status:'pending',apply_time:10}]}));
 assert.equal(M.days()[0].correctionStatus,'pending');assert.equal(M.agg(M.days()).placeExc,1);
});
test('审批已通过但日报旧版本标记待同步',()=>{
 load(payload(baseRecords,[daily('a','2026-08-03')],['a'],{approvals:[{userid:'a',date:'2026-08-03',status:'approved',fetched_at:'2026-08-31T13:00:00+08:00'}]}));assert.equal(M.days()[0].correctionStatus,'sync_pending');
});
test('同卡位新申请结果覆盖旧申请状态',()=>{
 load(payload(baseRecords,[daily('a','2026-08-03')],['a'],{approvals:[{userid:'a',date:'2026-08-03',status:'pending',correction_ts:1,apply_time:1},{userid:'a',date:'2026-08-03',status:'approved',correction_ts:1,apply_time:2,fetched_at:'2026-08-31T11:00:00+08:00'}]}));assert.equal(M.days()[0].correctionStatus,'corrected');
});
test('全日请假没有原始卡也保留假勤结构',()=>{
 load(payload([], [daily('a','2026-08-03',{checkin_count:0,actual_work_sec:0,sp_items:[{type:'请假',name:'年假',count:1,hours:8}]})],['a']));assert.equal(M.spStructure()[0][0],'年假');assert.equal(M.spStructure()[0][1],1);
});
test('当前部门覆盖历史关系',()=>{load(payload(baseRecords,[daily('a','2026-08-03')],['a']));assert.equal(M.days()[0].dept,'当前A部');assert.equal(S.records[0].dept,'当前A部');});
test('同条数数据重装不能命中旧缓存',()=>{load(payload(baseRecords,[daily('a','2026-08-03')],['a']));assert.equal(M.agg(M.days()).late,0);load(payload(baseRecords,[daily('a','2026-08-03',{exceptions:{'迟到':{count:1,duration:3600}}})],['a']));assert.equal(M.agg(M.days()).late,1);assert.equal(M.agg(M.days()).durLate,3600);});
test('两天50%到100%环比应为50个百分点',()=>{
 let rows=[daily('a','2026-08-03'),daily('b','2026-08-03',{checkin_count:0,actual_work_sec:0}),daily('a','2026-08-04'),daily('b','2026-08-04')];load(payload([],rows,['a','b'],{meta:{start:'2026-08-03',end:'2026-08-04'}}));assert.equal(M.kpis().find(k=>k.label==='出勤率（已核定）').trend.text,'▲50.0pp');
});
test('月报不覆盖19点后加班，筛选后仍一致',()=>{
 load(payload(baseRecords,[daily('a','2026-08-03')],['a'],{monthly:[{base_info:{acctid:'b'},overwork_info:{workday_over_sec:99999}}]}));assert.equal(M.workLoad().otComp.reduce((n,x)=>n+x.hours,0),1);S.filters.dept='不存在';S.applyFilters();assert.equal(M.workLoad().otComp.reduce((n,x)=>n+x.hours,0),0);
});
test('夜班22点至次日6点保留归属日，19点后交集8小时',()=>{
 const row=daily('a','2026-08-03',{segments:[{work_sec:79200,off_work_sec:108000}],earliest_min:1320,lastest_min:1800});
 const p=payload([record('a','2026-08-03',1320),record('a','2026-08-04',360,'下班打卡')],[row],['a']);load(p);assert.equal(M.days().length,1);assert.equal(M.days()[0].records.length,2);assert.equal(M.days()[0].otSec,28800);
});
test('HTML特殊字符统一转义',()=>{assert.equal(context.U.escapeHtml('<img src=x onerror="1">'), '&lt;img src=x onerror=&quot;1&quot;&gt;');});
test('特殊名称不污染分组索引',()=>{assert.equal(context.U.uniq(['__proto__','constructor']).length,2);assert.equal(context.U.groupBy(['__proto__'],x=>x)['__proto__'].length,1);});
test('休息日无标准班次不把午夜0点当标准',()=>{load(payload(baseRecords,[daily('a','2026-08-03',{day_type:1,segments:[],std_work_min:0,std_off_min:0,standard_work_sec:0})],['a']));assert.equal(M.days()[0].stdOut,null);assert.equal(M.days()[0].offsetOut,null);});
test('有原始卡但缺日报的人日不混入核定率分子',()=>{
 const a=load(payload([record('b','2026-08-03',540)],[daily('a','2026-08-03',{checkin_count:0,actual_work_sec:0,exceptions:{'缺卡':{count:2}}})],['a','b'],{rules:[{userid:'b',date:'2026-08-03',expected:true}]}));
 assert.equal(a.expPersonDays,2);assert.equal(a.presentPersonDays,1);assert.equal(a.ratePersonDays,1);assert.equal(a.ratePresentPersonDays,0);assert.equal(a.attendanceRate,0);assert.equal(a.missRate,1);assert.equal(a.missingExpectedDaily,1);assert.equal(a.dataCoverageRate,.5);
 assert.equal(M.dailySeries()[0].attendanceRate,0);assert.equal(M.weekCompare()[0].attendanceRate,0);assert.equal(M.monthCompare()[0].attendanceRate,0);assert.equal(M.personSummary().find(p=>p.userid==='b').attendanceRate,null);
});
test('已确认休息日缺少日报不算覆盖缺口',()=>{
 const a=load(payload(baseRecords,[daily('a','2026-08-03')],['a','b'],{rules:[{userid:'b',date:'2026-08-03',expected:false}]}));
 assert.equal(a.missingDaily,1);assert.equal(a.rateMissingPersonDays,0);assert.equal(a.dataCoverageRate,1);assert.equal(a.attendanceRate,1);
});
test('未知排班和缺日报重叠仅计一次缺口',()=>{
 const a=load(payload(baseRecords,[daily('a','2026-08-03')]));assert.equal(a.unknownSchedule,1);assert.equal(a.missingDaily,1);assert.equal(a.rateMissingPersonDays,1);assert.equal(a.rateMissingPeople,1);
});
test('月初缺数据仍留在底表，不自动当作入职前',()=>{
 const a=load(payload([record('a','2026-08-04',540)],[daily('a','2026-08-04')],['a'],{meta:{start:'2026-08-03',end:'2026-08-04'}}));
 assert.equal(M.days().length,2);assert.equal(M.days()[0].expected,null);assert.equal(a.ratePersonDays,1);assert.equal(a.rateMissingPersonDays,1);assert.equal(a.attendanceRate,1);assert.equal(S.users.a.entry_date,undefined);
});
test('全无核定依据保持空值，不显示0或100%',()=>{
 const a=load(payload([],[],['a']));assert.equal(a.attendanceRate,null);assert.equal(a.excRate,null);assert.equal(a.ratePersonDays,0);assert.equal(a.dataCoverageRate,0);assert.equal(M.kpis().find(k=>k.label==='出勤率（已核定）').val,'—');
});
test('当前率可显示，但不以覆盖不齐的样本给出环比优劣',()=>{
 load(payload([], [daily('a','2026-08-03'),daily('a','2026-08-04'),daily('b','2026-08-04')],['a','b'],{meta:{start:'2026-08-03',end:'2026-08-04'}}));
 const k=M.kpis().find(k=>k.label==='出勤率（已核定）');assert.equal(k.val,'100.0');assert.equal(k.trend.text,'覆盖不齐，暂不环比');
});
console.log('新业务口径反例：'+count+' 项通过');
