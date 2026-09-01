"""独立业务反例：不得依赖本机凭证，也不得触发真实API。"""
import copy
import fcntl
import json
import os
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch
import fetch_checkin as fc
import checkin_policy as policy
import server


class PolicyV2(unittest.TestCase):
    def scope_fixture(self):
        users = [{'userid':'keep','main_dept':'研发部'},
                 {'userid':'excluded','main_dept':'总经办'},
                 {'userid':'secondary','main_dept':'研发部','dept_names':['研发部','董事长']},
                 {'userid':'similar','main_dept':'其他人员支持部'}]
        rows = [{'userid':u['userid'],'date':'2026-08-03','dept':u['main_dept']} for u in users]
        return {'meta':{'users':4}, 'users':users, 'records':copy.deepcopy(rows), 'records_slim':copy.deepcopy(rows),
                'daily':copy.deepcopy(rows), 'rules':copy.deepcopy(rows), 'approvals':copy.deepcopy(rows),
                'monthly':[{'base_info':{'acctid':u['userid']}} for u in users]}

    def test_scope_filters_all_sections_without_mutating_raw(self):
        data=self.scope_fixture();before=copy.deepcopy(data)
        scoped=policy.apply_attendance_scope(data)
        self.assertEqual(data,before)
        for section in ('users','records','records_slim','daily','rules','approvals'):
            self.assertEqual({r['userid'] for r in scoped[section]},{'keep','similar'})
        self.assertEqual({m['base_info']['acctid'] for m in scoped['monthly']},{'keep','similar'})
        self.assertEqual(scoped['meta']['source_users'],4)
        self.assertEqual(scoped['meta']['users'],2)
        self.assertEqual(scoped['meta']['excluded_users'],2)
        self.assertEqual(policy.apply_attendance_scope(scoped),scoped)

    def test_scope_uses_current_membership_and_exact_names(self):
        data=self.scope_fixture();data['records'][0]['dept']='总经办'
        scoped=policy.apply_attendance_scope(data)
        self.assertIn('keep',{r['userid'] for r in scoped['records']})
        self.assertEqual(next(r for r in scoped['records'] if r['userid']=='keep')['dept'],'研发部')
        self.assertTrue(policy.department_excluded('集团 / 总经办 / 下属组'))
        self.assertFalse(policy.department_excluded('其他人员支持部'))

    def test_excluded_department_query_cannot_restore_people(self):
        scoped=server.filter_dataset(self.scope_fixture(),{'dept':'总经办'})
        for section in ('users','records','daily','monthly','rules','approvals'):
            self.assertEqual(scoped[section],[])

    def test_saved_csv_excludes_people_but_json_keeps_raw(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(fc,'DATA_DIR',temp):
            fc.save_dataset(self.scope_fixture())
            self.assertEqual(len(fc.load_existing()['users']),4)
            with open(os.path.join(temp,'checkin_records.csv'),encoding='utf-8-sig') as f:
                exported=f.read()
            self.assertNotIn('excluded',exported)
            self.assertNotIn('secondary',exported)
            self.assertIn('keep',exported)

    def test_cross_process_lock_prevents_overlapping_fetch(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(fc, 'DATA_DIR', temp):
            with open(os.path.join(temp,'.fetch.lock'),'a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises(RuntimeError):fc.main([])

    def test_day_boundary_and_timezone(self):
        value = fc.day_ts(datetime(2026, 8, 3, 15, 45))
        self.assertEqual(datetime.fromtimestamp(value, fc.TZ).strftime('%H:%M'), '00:00')
        r = fc.norm_record({'userid':'a','checkin_time':value+30600,'sch_checkin_time':value+30600}, {})
        self.assertEqual(r['sch_time'], '08:30')
        self.assertEqual(r['date'], '2026-08-03')

    def test_zero_and_absent_field_differ(self):
        self.assertEqual(fc.norm_daily({'summary_info':{'regular_work_sec':0}}, {})['actual_work_sec'], 0)
        self.assertIsNone(fc.norm_daily({}, {})['actual_work_sec'])

    def test_all_shift_segments_preserved(self):
        d=fc.norm_daily({'base_info':{'rule_info':{'checkintime':[{'work_sec':30600,'off_work_sec':41400},{'work_sec':46800,'off_work_sec':63000}]}},'summary_info':{'standard_work_sec':27000}}, {})
        self.assertEqual((d['std_work_min'],d['std_off_min']), (510,1050))
        self.assertEqual(len(d['segments']),2)
        self.assertEqual(d['standard_work_sec'],27000)

    def test_night_shift(self):
        self.assertEqual(policy.segments([{'work_sec':79200,'off_work_sec':21600}])[0]['off_work_sec'],108000)

    def test_night_assignment_is_idempotent(self):
        records=[{'userid':'a','date':'2026-08-04','attendance_date':'2026-08-04','type':'下班打卡','minute_of_day':360}]
        daily=[{'userid':'a','date':date,'segments':[{'work_sec':79200,'off_work_sec':108000}]} for date in ('2026-08-02','2026-08-03')]
        fc.assign_attendance_dates(records,daily,[])
        fc.assign_attendance_dates(records,daily,[])
        self.assertEqual(records[0]['attendance_date'],'2026-08-03')

    def test_placeholder_does_not_become_punch(self):
        r=fc.norm_record({'userid':'a','checkin_time':1785717000,'exception_type':'未打卡'}, {})
        self.assertTrue(r['is_placeholder'])

    def test_fallback_contacts_do_not_mask_daily_names(self):
        d=fc.norm_daily({'base_info':{'acctid':'a','name':'测试员工','departs_name':'测试部门'}},{'a':{'name':'a','main_dept':'未分组'}})
        self.assertEqual(d['name'],'测试员工')
        self.assertEqual(d['dept'],'测试部门')

    def test_leave_units_and_approval_refs_retained(self):
        d=fc.norm_daily({'sp_items':[{'type':1,'duration':86400,'time_type':0}], 'holiday_infos':[{'sp_number':'fake-1'}]}, {})
        self.assertEqual(d['sp_items'][0]['duration'],86400)
        self.assertEqual(d['sp_items'][0]['time_type'],0)
        self.assertEqual(d['approval_refs'],['fake-1'])

    def base(self):
        return {'meta':{'start':'2026-08-01','end':'2026-08-03'},'users':[{'userid':'a'},{'userid':'b'}],
                'records':[{'userid':'a','date':'2026-08-03','ts':1,'type':'上班打卡'},{'userid':'b','date':'2026-08-03','ts':2,'type':'上班打卡'}],
                'daily':[{'userid':'a','date':'2026-08-03'},{'userid':'b','date':'2026-08-03'}], 'monthly':[], 'rules':[]}

    def fresh(self, coverage):
        return {'meta':{'start':'2026-08-03','end':'2026-08-03','requested_users':['a'],'coverage':coverage},'records':[], 'daily':[], 'users':[], 'rules':[], 'monthly':[]}

    def test_success_empty_only_replaces_requested_person(self):
        new=self.fresh({'records':[{'users':['a'],'start':'2026-08-03','end':'2026-08-03'}]})
        merged=fc.merge_dataset(self.base(),new,'2026-08-03','2026-08-03')
        self.assertEqual([r['userid'] for r in merged['records']],['b'])
        self.assertEqual(len(merged['daily']),2)

    def test_failed_and_skipped_partitions_preserved(self):
        merged=fc.merge_dataset(self.base(),self.fresh({'records':[],'daily':[]}), '2026-08-03','2026-08-03')
        self.assertEqual(len(merged['records']),2)
        self.assertEqual(len(merged['daily']),2)

    def test_same_timestamp_different_card_slots_not_lost(self):
        new=self.fresh({'records':[]})
        new['records']=[{'userid':'a','date':'2026-08-03','ts':1,'type':'上班打卡'}, {'userid':'a','date':'2026-08-03','ts':1,'type':'下班打卡'}]
        merged=fc.merge_dataset(self.base(),new,'2026-08-03','2026-08-03')
        self.assertEqual(len(merged['records']),3)

    def test_monthly_has_explicit_query_interval(self):
        old=self.base();old['monthly']=[{'base_info':{'acctid':'a'},'query_start':'2026-07-01','query_end':'2026-07-31'}]
        new=self.fresh({});new['monthly']=[{'base_info':{'acctid':'a'},'query_start':'2026-08-01','query_end':'2026-08-30'}]
        self.assertEqual(len(fc.merge_dataset(old,new,'2026-08-01','2026-08-30')['monthly']),2)

    def test_current_organization_updates_history(self):
        new=self.fresh({});new['users']=[{'userid':'a','name':'新名','main_dept':'新部门'}]
        merged=fc.merge_dataset(self.base(),new,'2026-08-03','2026-08-03')
        self.assertEqual(merged['records'][0]['dept'],'新部门')

    def approval(self,status=2):
        return {'sp_no':'fake-1','sp_status':status,'apply_time':1788170000,'applyer':{'userid':'a'},'apply_data':{'contents':[{'control':'PunchCorrection','value':{'punch_correction':{'state':'地点异常','time':1785717000,'version':1,'daymonthyear':1785686400}}}]}}

    def test_approval_uses_target_day_not_submission_day(self):
        row=policy.normalize_approval(self.approval(),{'a'})[0]
        self.assertEqual(row['date'],'2026-08-03')
        self.assertEqual(row['status'],'approved')
        self.assertNotIn('apply_data',row)

    def test_pending_rejected_revoked_states(self):
        for code,status in [(1,'pending'),(3,'rejected'),(4,'withdrawn'),(6,'revoked'),(7,'deleted')]:
            self.assertEqual(policy.normalize_approval(self.approval(code),{'a'})[0]['status'],status)

    def test_approval_outside_roster_not_saved(self):
        self.assertEqual(policy.normalize_approval(self.approval(),{'b'}),[])

    def test_approval_pagination_and_filter(self):
        calls=[]
        class Client:
            def call(inner,path,body):
                calls.append((path,body))
                if path.endswith('getapprovaldetail'):return {'info':self.approval()}
                return {'sp_no_list':[]} if body['new_cursor'] else {'sp_no_list':['fake-1'],'new_next_cursor':'next'}
        with patch('time.sleep'):
            rows,status=policy.fetch_approvals(Client(),['a'],datetime(2026,8,1),datetime(2026,8,31))
        self.assertTrue(status['available']);self.assertEqual(len(rows),1)
        self.assertEqual(calls[0][1]['filters'],[{'key':'record_type','value':'2'}])
        self.assertEqual(calls[-1][1]['new_cursor'],'next')

    def test_rule_special_workday_and_holiday(self):
        item={'userid':'a','group':{'grouptype':1,'sync_holidays':True,'spe_workdays':[{'timestamp':fc.day_ts(datetime(2026,8,1)),'checkintime':[{'work_sec':32400,'off_work_sec':64800}]}],'spe_offdays':[{'timestamp':fc.day_ts(datetime(2026,8,3))}]}}
        self.assertTrue(policy.rule_day(item,'2026-08-01')['expected'])
        self.assertFalse(policy.rule_day(item,'2026-08-03')['expected'])
        self.assertIsNone(policy.rule_day(item,'2026-08-04')['expected'])

    def test_daily_rule_requires_datetime_and_info(self):
        calls=[]
        class Client:
            def call(inner,path,body):
                calls.append(body);return {'info':[{'userid':'a','group':{'grouptype':1,'checkindate':[{'workdays':[1,2,3,4,5],'checkintime':[{'work_sec':32400,'off_work_sec':64800}]}]}}]}
        with patch('time.sleep'):
            rows=fc.fetch_rules(Client(),['a'],start=datetime(2026,8,3),end=datetime(2026,8,4))
        self.assertEqual(len(rows),2);self.assertEqual(calls[0]['datetime'],fc.day_ts(datetime(2026,8,3)))

    def test_invalid_params_release_lock(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(server,'STATUS',os.path.join(temp,'status.json')):
            server._FETCH_LOCK.acquire()
            server.run_fetch({'days':'bad'})
            self.assertFalse(server._FETCH_LOCK.locked())

    def test_request_validation(self):
        for params in [[],{'days':1000},{'start':'2026-08-04','end':'2026-08-03'},{'users':['a']},{'noDaily':'false'}]:
            with self.assertRaises((ValueError,TypeError)):server.validate_fetch_params(params)

    def test_csv_formula_neutralized(self):
        for value in ['=1+1','+SUM(A1)','@SUM(A1)','\t=1']:
            self.assertTrue(fc.csv_safe(value).startswith("'"))

    def test_atomic_snapshot_and_previous(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(fc,'DATA_DIR',temp):
            fc.save_dataset(self.base());fc.save_dataset(self.fresh({}))
            with open(os.path.join(temp,'checkin_data.json.previous')) as f:old=json.load(f)
            self.assertEqual(len(old['records']),2)
            with open(os.path.join(temp,'checkin_records.csv'),encoding='utf-8-sig') as f:self.assertEqual(len(f.readlines()),1)

    def test_invalid_json_does_not_destroy_snapshot(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(fc,'DATA_DIR',temp):
            fc.save_dataset(self.base());bad=self.base();bad['invalid']=float('nan')
            with self.assertRaises(ValueError):fc.save_dataset(bad)
            self.assertEqual(len(fc.load_existing()['records']),2)


if __name__=='__main__':unittest.main()
