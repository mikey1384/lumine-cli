import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { testWorkRoot } from './helpers/work-directory.js';
import { parseArgs } from '../lib/commands.js';
import { scheduleCommand } from '../lib/network-schedule.js';
import { networkCredentialDirectory } from '../lib/network.js';
import { computerScheduler, scheduleFiles } from '../lib/network-scheduler.js';
import { privateJson, runScheduledCheckin, runCheckinRuntime } from '../lib/network-checkin-runner.js';

const quiet = {outcome:'quiet',summary:'',action:{kind:'none'}};
const discovery = {outcome:'discovery',summary:'A useful garden idea.',action:{kind:'none'}};
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(testWorkRoot(),'network-checkins-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const config = {directory,agent:'fixture_agent',scheduleId:'fixture-schedule',runtime:'codex',providerPath:process.execPath,
    nodePath:process.execPath,apiUrl:'http://127.0.0.1:9876',authFile:path.join(directory,'auth.json'),label:'net.twinkle.lumine.fixture',intervalMinutes:30,path:process.env.PATH};
  const status = {agent:{id:81,status:'active'},checkins:{mode:'enabled',revision:1,intervalMinutes:30,schedule:{id:config.scheduleId}}};
  const calls = [], receipts = new Map();
  let loseResponse = false;
  const call = async (name,body) => {
    calls.push({name,body:body && structuredClone(body)});
    if (name === 'checkin-status') return structuredClone(status);
    if (name === 'checkin-begin') return {allowed:true,context:{posts:[{id:1,body:'A new idea'}],inbox:[],permissions:{posts:false,replies:false}}};
    if (name === 'checkin-complete') {
      if (!receipts.has(body.runId)) receipts.set(body.runId,{result:{...body.result,runId:body.runId}});
      if (loseResponse) {loseResponse=false; throw new Error('Lost acknowledgement');}
      return receipts.get(body.runId);
    }
    throw Error(name);
  };
  return {directory,config,status,calls,receipts,call,lose:() => {loseResponse=true;}};
}

test('off, paused, unconfirmed and unavailable identities never start the runtime',async t => {
  const f = await fixture(t); let runs=0;
  for (const mode of ['off','paused']) {
    f.status.checkins.mode=mode;
    assert.equal((await runScheduledCheckin(f.config,f.call,async () => {runs++;})).skipped,mode);
  }
  f.status.checkins.mode='enabled'; f.status.checkins.schedule=null;
  assert.equal((await runScheduledCheckin(f.config,f.call,async () => {runs++;})).skipped,'setup_pending');
  f.status.checkins.schedule={id:f.config.scheduleId};f.status.agent.status='suspended';
  assert.equal((await runScheduledCheckin(f.config,f.call,async () => {runs++;})).skipped,'paused');
  assert.equal(runs,0); assert.ok(f.calls.every(c => c.name === 'checkin-status'));
});

test('a lost completion acknowledgement reuses the persisted result without running the model or publishing twice',async t => {
  const f = await fixture(t); let runs=0;
  const run = async () => {runs++;return discovery;};
  f.lose(); await assert.rejects(runScheduledCheckin(f.config,f.call,run),/Lost acknowledgement/);
  const pending=JSON.parse(await fs.readFile(path.join(f.directory,'pending.json'),'utf8'));
  assert.equal((await fs.stat(path.join(f.directory,'pending.json'))).mode & 0o777,0o600);
  const result=await runScheduledCheckin(f.config,f.call,run);
  assert.equal(result.result.runId,pending.runId); assert.equal(runs,1); assert.equal(f.receipts.size,1);
  assert.equal(f.calls.filter(c => c.name === 'checkin-begin').length,1);
  await assert.rejects(fs.stat(path.join(f.directory,'pending.json')),e => e.code==='ENOENT');
});

test('empty checks and not-due ticks stay quiet without model calls; overlap and damaged stale locks recover',async t => {
  const f=await fixture(t); let runs=0;
  const run=async () => {runs++;return discovery;};
  const emptyCall=(name,body) => name === 'checkin-begin' ? {allowed:true,context:{posts:[],inbox:[]}} : f.call(name,body);
  assert.equal((await runScheduledCheckin(f.config,emptyCall,run)).result.outcome,'quiet');
  const dueCall=(name,body) => name === 'checkin-begin' ? {allowed:false,reason:'not_due'} : f.call(name,body);
  assert.equal((await runScheduledCheckin(f.config,dueCall,run)).skipped,'not_due');
  const lock=path.join(f.directory,'runner.lock');
  await privateJson(lock,{pid:process.pid});
  assert.equal((await runScheduledCheckin(f.config,f.call,run)).skipped,'busy');
  await fs.writeFile(lock,'');await fs.utimes(lock,1,1);
  await runScheduledCheckin(f.config,emptyCall,run);
  await privateJson(lock,{pid:process.pid});await fs.utimes(lock,1,1);
  await runScheduledCheckin(f.config,emptyCall,run);
  assert.equal(runs,0);
});

test('invalid publishing and runtime failures produce a private failure receipt',async t => {
  const f=await fixture(t);
  const rejectPublication=async (name,body) => {
    if (name==='checkin-complete' && body.result.action.kind==='post') throw Object.assign(new Error('Not permitted'),{data:{code:'network_checkin_permission'}});
    return f.call(name,body);
  };
  const invalid=await runScheduledCheckin(f.config,rejectPublication,async () => ({...discovery,action:{kind:'post',body:'Disallowed'}}));
  assert.equal(invalid.result.outcome,'failed');assert.equal(invalid.result.action.kind,'none');
  const failed=await runScheduledCheckin(f.config,f.call,async () => {throw new Error('Saved login expired');});
  assert.equal(failed.result.outcome,'failed');assert.match(failed.result.summary,/login expired/);
});

test('scheduled connection failures are recorded locally even when the API session cannot be reached',async t => {
  const f=await fixture(t), auth={userId:5};
  const options={apiUrl:f.config.apiUrl,authFile:f.config.authFile,networkArgs:['schedule','run'],networkOptions:{agent:f.config.agent}};
  const directory=path.join(networkCredentialDirectory(options,auth),'schedules',f.config.agent);
  await fs.mkdir(directory,{recursive:true});
  await privateJson(path.join(directory,'schedule.json'),{...f.config,directory});
  await assert.rejects(scheduleCommand(options,auth,{
    assertAuthScope:async()=>{throw Error('Unnecessary session preflight');},
    call:async()=>{throw Error('Network is unreachable');}
  }),/Network is unreachable/);
  assert.match(JSON.parse(await fs.readFile(path.join(directory,'last-error.json'),'utf8')).message,/unreachable/);
  await assert.rejects(fs.stat(path.join(directory,'runner.lock')),e=>e.code==='ENOENT');
});

test('install requires opt-in, verifies the actual OS job before confirmation, and resolves a lost confirmation response',async t => {
  const f=await fixture(t), events=[];
  const options={...parseArgs(['network','schedule','install','--agent','fixture_agent','--runtime','codex','--provider-path',process.execPath,'--json']),apiUrl:f.config.apiUrl,authFile:f.config.authFile};
  const auth={userId:5,token:'synthetic'};
  let mode='off', confirmedId=null;
  const dependencies={assertAuthScope:async () => ({userId:5}), scheduler:config => computerScheduler(config,{platform:'darwin',uid:502,home:f.directory,exec:async (_binary,args) => {events.push(args[0]);return {stdout:''};}}),
    call:async (name,body) => {
      events.push(name);
      if (name==='checkin-status') return {agent:{id:81},checkins:{mode,revision:1,intervalMinutes:30,schedule:confirmedId ? {id:confirmedId} : null}};
      if (name==='checkin-schedule') {confirmedId=body.scheduleId;throw Error('Lost confirmation response');}
    }};
  await assert.rejects(scheduleCommand(options,auth,dependencies),/Your agents first/);
  assert.ok(!events.includes('bootstrap'));mode='enabled';events.length=0;
  await scheduleCommand(options,auth,dependencies);
  assert.ok(events.indexOf('bootstrap') < events.indexOf('print'));
  assert.ok(events.indexOf('print') < events.indexOf('checkin-schedule'));
  assert.ok(events.indexOf('kickstart') > events.indexOf('checkin-schedule'));
  const files=await fs.readdir(path.join(f.directory,'Library','LaunchAgents'));
  assert.equal(files.length,1);
  const plist=await fs.readFile(path.join(f.directory,'Library','LaunchAgents',files[0]),'utf8');
  assert.ok(plist.includes('runtime/bin/lumine.js'));assert.ok(plist.includes('<integer>1800</integer>'));
});

test('an unverified installation never creates a scheduling receipt, and Linux timers use nonblocking startup',async t => {
  const f=await fixture(t), events=[];
  const options={...parseArgs(['network','schedule','install','--agent','fixture_agent','--runtime','codex','--provider-path',process.execPath]),apiUrl:f.config.apiUrl,authFile:f.config.authFile};
  await assert.rejects(scheduleCommand(options,{userId:5},{assertAuthScope:async()=>({userId:5}),
    call:async name => {events.push(name);return f.status;},
    scheduler:config => computerScheduler(config,{platform:'darwin',home:f.directory,exec:async (_b,args) => {
      if (args[0]==='print') throw Error('OS job was not loaded');return {stdout:''};
    }})}),/not loaded/);
  assert.ok(!events.includes('checkin-schedule'));
  const linuxCalls=[], scheduler=computerScheduler({...f.config,path:'/bin:$money/%path'},{platform:'linux',home:f.directory,exec:async (_b,args)=>{linuxCalls.push(args);return {stdout:''};}});
  await scheduler.install();await scheduler.start();await scheduler.remove();
  assert.ok(linuxCalls.some(args => args.includes('--no-block')));
  assert.ok(linuxCalls.some(args => args.includes('is-enabled')));assert.ok(linuxCalls.some(args => args.includes('is-active')));
  assert.ok(linuxCalls.some(args => args.includes('disable')));
  assert.throws(()=>scheduleFiles(f.config,{platform:'win32'}),/currently support/);
});

test('both connected runtime adapters return structured decisions with no inherited publishing tools',async t => {
  const f=await fixture(t);
  const claude=path.join(f.directory,'fake-claude.cjs');
  await fs.writeFile(claude,`#!/usr/bin/env node
const a=process.argv.slice(2);
if(process.env.CLAUDE_CONFIG_DIR!==${JSON.stringify(path.join(f.directory,'saved-profile'))})process.exit(5);
if(a[a.indexOf('--tools')+1]!=='' || a[a.indexOf('--allowedTools')+1]!=='' || !a.includes('--strict-mcp-config'))process.exit(3);
if(Object.keys(JSON.parse(a[a.indexOf('--mcp-config')+1]).mcpServers).length)process.exit(4);
process.stdout.write(JSON.stringify({structured_output:${JSON.stringify(discovery)}}));
`,{mode:0o755});
  assert.deepEqual(await runCheckinRuntime({...f.config,runtime:'claude-code',providerPath:claude,runtimeEnvironment:{CLAUDE_CONFIG_DIR:path.join(f.directory,'saved-profile')}},{posts:[],inbox:[]}),discovery);
  const codex=path.join(f.directory,'fake-codex.cjs');
  await fs.writeFile(codex,`#!/usr/bin/env node
if(process.argv[2]==='features'){console.log('shell_tool stable true\\ncode_mode_host stable true\\nunified_exec stable true');process.exit(0);}
if(process.argv[2]==='mcp'){console.log('[]');process.exit(0);}
const send=x=>console.log(JSON.stringify(x));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'synthetic'}});
 if(m.method==='thread/start'){
  if(m.params.dynamicTools.length || m.params.sandbox!=='read-only' || !m.params.ephemeral)process.exit(3);
  send({id:m.id,result:{thread:{id:'synthetic'}}});
 }
 if(m.method==='mcpServerStatus/list')send({id:m.id,result:{data:[],nextCursor:null}});
 if(m.method==='turn/start'){
  if(!m.params.outputSchema)process.exit(4);
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'item/completed',params:{item:{type:'agentMessage',text:JSON.stringify(${JSON.stringify(discovery)})}}});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});
 }
});
`,{mode:0o755});
  assert.deepEqual(await runCheckinRuntime({...f.config,providerPath:codex},{posts:[],inbox:[]}),discovery);
});

test('removal keeps a retryable receipt when the server is unavailable and never runs the removed schedule',async t => {
  const f=await fixture(t), auth={userId:5};
  const options={apiUrl:f.config.apiUrl,authFile:f.config.authFile,json:true,networkArgs:['schedule','remove'],networkOptions:{agent:f.config.agent}};
  const directory=path.join(networkCredentialDirectory(options,auth),'schedules',f.config.agent);
  const configPath=path.join(directory,'schedule.json');
  await fs.mkdir(directory,{recursive:true});
  await privateJson(configPath,{...f.config,directory});
  let calls=0, online=false;
  const dependencies={scheduler:()=>({remove:async()=>{}}),call:async(name,body)=>{
    calls++; assert.equal(name,'checkin-schedule'); assert.equal(body.scheduleId,f.config.scheduleId); assert.equal(body.removed,true);
    if(!online)throw Error('Offline');
  }};
  await scheduleCommand(options,auth,dependencies);
  assert.equal(JSON.parse(await fs.readFile(configPath,'utf8')).removed,true);
  await scheduleCommand({...options,networkArgs:['schedule','run']},auth,dependencies);
  assert.equal(calls,1,'removed timer cannot start an unconfirmed run');
  online=true;await scheduleCommand(options,auth,dependencies);
  assert.equal(calls,2);
  await assert.rejects(fs.stat(configPath),e=>e.code==='ENOENT');
});

test('Linux removal tolerates missing inactive units but preserves evidence when cleanup cannot be confirmed',async t => {
  const f=await fixture(t);let absent=true;
  const scheduler=computerScheduler(f.config,{platform:'linux',home:f.directory,exec:async(_binary,args)=>{
    if(['disable','stop'].includes(args[1]))throw Error('Unit cleanup failed');
    if(args[1]==='show')return {stdout:absent?'LoadState=not-found\nActiveState=inactive\n':'LoadState=loaded\nActiveState=active\n'};
    return {stdout:''};
  }});
  await scheduler.remove();await scheduler.remove();
  await fs.mkdir(path.dirname(scheduler.files[0].filename),{recursive:true});
  await fs.writeFile(scheduler.files[0].filename,'Existing service definition');
  absent=false;await assert.rejects(scheduler.remove(),/cleanup failed/);
  assert.equal(await fs.readFile(scheduler.files[0].filename,'utf8'),'Existing service definition');
});

test('a stalled runtime and its descendants are terminated within the bounded check-in',async t => {
  const f=await fixture(t), worker=path.join(f.directory,'stalled.cjs');
  await fs.writeFile(worker,`const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync('../child.pid',String(child.pid));setInterval(()=>{},1000);`);
  await assert.rejects(runCheckinRuntime(f.config,{}, {timeoutMs:10000,worker}),/did not finish/);
  const pid=Number(await fs.readFile(path.join(f.directory,'child.pid'),'utf8'));
  // The OS may briefly retain a just-killed descendant; do not mistake that
  // reap delay for a live model process.
  let alive=true;
  for(let i=0;i<20 && alive;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,25));}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}}
  assert.equal(alive,false);
});
