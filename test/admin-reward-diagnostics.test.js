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
