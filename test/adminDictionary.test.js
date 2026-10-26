import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';

const operation = args => parseAdminOperation(parseArgs(['admin','dictionary',...args]));
test('Korean review queue preserves pagination and is read-only', () => {
  const result = operation(['korean-pending','--cursor','1793000000:123','--limit','100']);
  assert.equal(new URL(result.path,'https://example.invalid').searchParams.get('cursor'),'1793000000:123');
  assert.equal(result.mutates,false);
  assert.equal(operation(['korean-status']).requiresRun,false);
  assert.throws(()=>operation(['korean-pending','--limit','101']));
});
test('review payload preserves revisions; dry-run cannot mutate and apply is explicit', () => {
  const dir = new URL('../../work/korean-word-bank-20261027/cli-fixtures/', import.meta.url).pathname;
  fs.mkdirSync(dir,{recursive:true});
  const file = path.join(dir,'review.json');
  const items = [{wordId:123,word:'example',expectedRevision:1,expectedSourceHash:'a'.repeat(64),koreanDefinition:'예; 본보기.',reason:'Checked the ordinary noun senses.'}];
  fs.writeFileSync(file,JSON.stringify({items}));
  const dry = operation(['korean-review',file,'--dry-run']);
  assert.equal(dry.mutates,false);
  assert.deepEqual(dry.body.items,items);
  const apply = operation(['korean-review',file]);
  assert.equal(apply.mutates,true); assert.equal(apply.body.dryRun,false);
});
