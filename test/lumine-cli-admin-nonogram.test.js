import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { testWorkRoot } from './helpers/work-directory.js';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';
import { formatNonogramResult } from '../lib/admin-nonogram.js';

const op=(...args)=>parseAdminOperation(parseArgs(['admin','nonogram',...args]));
test('Nonogram CLI: read inventory; dry-run imports/retirement; explicit confirmed mutations',()=>{
  const dir=fs.mkdtempSync(path.join(testWorkRoot(),'nonogram-'));
  try {
    const file=path.join(dir,'pictures.json');
    const pictures=[{key:'test-picture',rows:['11111']}];
    fs.writeFileSync(file,JSON.stringify(pictures));
    assert.equal(op('status').mutates,false);
    const dry=op('add','--file',file);
    assert.equal(dry.path,'/cli/admin/nonogram/add');
    assert.deepEqual(dry.body,{pictures,dryRun:true});
    assert.equal(dry.mutates,false); assert.equal(dry.requiresRun,false);
    const real=op('add','--file',file,'--confirm');
    assert.equal(real.body.dryRun,false); assert.equal(real.mutates,true);
    assert.throws(()=>op('add','--file',file,'--confirm=false'),/--confirm on its own/);
    const retire=op('retire','test-picture');
    assert.deepEqual(retire.body,{key:'test-picture',retire:true,dryRun:true});
    assert.equal(retire.mutates,false);
    const restore=op('restore','test-picture','--confirm');
    assert.deepEqual(restore.body,{key:'test-picture',retire:false,dryRun:false});
    assert.equal(restore.mutates,true);
    assert.throws(()=>op('retire'),/exact picture key/);
    fs.writeFileSync(file,'[]'); assert.throws(()=>op('add','--file',file),/1–150/);
    fs.writeFileSync(file,JSON.stringify(Array(151).fill({}))); assert.throws(()=>op('add','--file',file),/1–150/);
    assert.throws(()=>op('delete'),/Usage/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('inventory distinguishes total pictures from the least unseen supply',()=>{
  const lines=formatNonogramResult({operation:op('status'),data:{sizes:[{size:15,total:60,leastUnseen:12,reserveDays:4,targetDays:14}]}});
  assert.match(lines[0],/60 pictures/); assert.match(lines[0],/12 unseen/); assert.match(lines[0],/4 days/);
});
