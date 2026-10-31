import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';
import { testWorkRoot } from './helpers/work-directory.js';

const operation = args => parseAdminOperation(parseArgs(['admin','dictionary',...args]));
test('Korean review queue preserves pagination and is read-only', () => {
  const result = operation(['korean-pending','--cursor','1793000000:123','--limit','100']);
  assert.equal(new URL(result.path,'https://example.invalid').searchParams.get('cursor'),'1793000000:123');
  assert.equal(result.mutates,false);
  assert.equal(operation(['korean-status']).requiresRun,false);
  assert.throws(()=>operation(['korean-pending','--limit','101']));
});
test('review payload preserves revisions; it previews unless --confirm', () => {
  const file = path.join(testWorkRoot(),`korean-review-${process.pid}.json`);
  const items = [{wordId:123,word:'example',expectedRevision:1,expectedSourceHash:'a'.repeat(64),koreanDefinition:'예; 본보기.',reason:'Checked the ordinary noun senses.'}];
  try {
    fs.writeFileSync(file,JSON.stringify({items}));
    const preview = operation(['korean-review',file]);
    assert.equal(preview.mutates,false); assert.equal(preview.body.dryRun,true);
    assert.deepEqual(preview.body.items,items);
    const dry = operation(['korean-review',file,'--dry-run']);
    assert.equal(dry.mutates,false); assert.equal(dry.body.dryRun,true);
    const apply = operation(['korean-review',file,'--confirm']);
    assert.equal(apply.mutates,true); assert.equal(apply.body.dryRun,false);
    assert.throws(()=>operation(['korean-review',file,'--confirm','--dry-run']),/not both/);
    assert.throws(()=>operation(['korean-review',file,'--confirm=yes']),/on its own/);
  } finally { fs.unlinkSync(file); }
});
