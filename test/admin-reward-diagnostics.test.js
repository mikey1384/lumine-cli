import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs} from '../lib/commands.js';
import {parseAdminOperation} from '../lib/admin.js';
test('reward diagnostics are a read-only scoped investigation with bounded window',()=>{
 const op=parseAdminOperation(parseArgs(['admin','reward-diagnostics','--build','2799','--user','5','--days','2','--cursor','9']));
 assert.equal(op.method,'GET');assert.equal(op.path,'/cli/admin/reward-diagnostics?buildId=2799&userId=5&days=2&before=9');
 assert.equal(op.requiresRun,false);
 assert.throws(()=>parseAdminOperation(parseArgs(['admin','reward-diagnostics','--days','31'])));
});
import {formatRewardDiagnostics} from '../lib/admin.js';
test('reward diagnostics print readable lines, never "undefined"',()=>{
 const lines=formatRewardDiagnostics({coverage:'build',since:1792800000,until:1792886400,limitations:['client events are sampled'],nextCursor:'10200',
  challenges:[{}],receipts:[{},{}],canonicalRecordsTruncated:false,
  events:[{id:'10261',source:'client',buildId:1366,userId:5,operation:'start',outcome:'response',durationMs:180,createdAt:1792804892,details:{httpStatus:200}},
   {id:'10262',source:'server',buildId:1366,userId:5,operation:'claim',outcome:'refused',durationMs:42,createdAt:1792804900,details:{httpStatus:409,errorCode:'build_reward_too_fast'}}]});
 const text=lines.join('\n');
 assert.ok(!text.includes('undefined'),text);
 assert.match(lines[0],/^Reward diagnostics: 2 event\(s\), 10-24 00:00 → 10-25 00:00 UTC \(build\)$/);
 assert.ok(lines.includes('  start: 1 response'));
 assert.ok(lines.includes('#10262 10-24 01:21 server build 1366 user 5 claim → refused (409, build_reward_too_fast, 42 ms)'),text);
 assert.ok(text.includes('Server records: 1 challenge(s), 2 receipt(s).'));
 assert.ok(text.includes('More: --cursor 10200'));
 assert.equal(formatRewardDiagnostics({}).join(''),'Reward diagnostics: 0 event(s), ? → ? UTC');
});
