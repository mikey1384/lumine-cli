import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { testWorkRoot } from './helpers/work-directory.js';
import { parseArgs } from '../lib/commands.js';
import { parseNetworkOperation, loadNetworkConnection, saveNetworkConnection, networkCredentialDirectory, callNetwork, validateInboxPage } from '../lib/network.js';
import { boundedLines, validateNetworkTool } from '../lib/network-mcp.js';

const cli = fileURLToPath(new URL('../bin/lumine.js',import.meta.url));
const credential = { id:'fixture',token:`ln_${'a'.repeat(64)}`,expiresAt:Math.floor(Date.now()/1000)+3600 };
const agent = { id:8,handle:'ember_test',name:'Ember',owner:{id:5,username:'fixture_owner'} };
const operationId = 'f0faaa11-1234-4123-8123-abcdef123456';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(testWorkRoot(),'network-'));
  const requests = [];
  const server = http.createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({path:req.url,method:req.method,body,agentToken:req.headers['x-lumine-agent-token']});
    res.setHeader('content-type','application/json');
    if (req.url === '/cli/session') return res.end(JSON.stringify({userId:5,scopes:['build:read','build:write']}));
    if (req.url === '/cli/network/join') return res.end(JSON.stringify({agent,credential}));
    if (req.url === '/cli/network/whoami') return res.end(JSON.stringify({agent}));
    if (req.url === '/cli/network/post') return res.end(JSON.stringify({post:{id:91,body:body.body,author:agent},operationId:body.operationId}));
    res.end(JSON.stringify({posts:[],cursor:null}));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir,{recursive:true,force:true}); });
  const apiUrl = `http://127.0.0.1:${server.address().port}`, authFile = path.join(dir,'auth.json');
  await fs.writeFile(authFile,JSON.stringify({apiUrl,token:'fixture-token',userId:5}),{mode:0o600});
  return { options:{apiUrl,authFile,timeoutMs:2000,networkOptions:{}},auth:{token:'fixture-token',userId:5},requests,dir };
}
async function run(t,f,args,input) {
  const child = spawn(process.execPath,[cli,...args,'--api-url',f.options.apiUrl,'--auth-file',f.options.authFile,'--no-update-check'],{stdio:['pipe','pipe','pipe']});
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data',c => stdout += c); child.stderr.on('data',c => stderr += c);
  child.stdin.end(input || '');
  const timeout = setTimeout(() => child.kill('SIGKILL'),10000);
  const [code] = await once(child,'close'); clearTimeout(timeout);
  return { code,stdout,stderr };
}
test('parses real CLI arguments, preserves retry IDs and rejects missing identity/content choices', () => {
  const options = parseArgs(['network','reply','12','--body-file','reply.txt','--parent','3','--agent','ember_test','--operation-id',operationId,'--json']);
  const operation = parseNetworkOperation(options);
  assert.equal(operation.path,'reply'); assert.equal(operation.body.postId,12); assert.equal(operation.body.parentReplyId,3);
  assert.equal(operation.body.operationId,operationId); assert.equal(options.networkOptions.agent,'ember_test'); assert.equal(options.json,true);
  assert.equal(parseNetworkOperation(parseArgs(['network','vote','5','--remove'])).body.voted,false);
  assert.throws(() => parseNetworkOperation({networkArgs:['post'],networkOptions:{title:'Hello'}}),/body-file/);
  assert.throws(() => parseNetworkOperation({networkArgs:['reply','1 OR 1=1']}),/integer/);
});
test('credentials stay private, owner/origin isolated, with explicit selection for multiple agents',async t => {
  const f = await fixture(t);
  await saveNetworkConnection(f.options,f.auth,{agent,credential});
  const connected = await loadNetworkConnection(f.options,f.auth);
  assert.equal((await fs.stat(connected.filename)).mode & 0o777,0o600);
  assert.equal((await fs.stat(networkCredentialDirectory(f.options,f.auth))).mode & 0o777,0o700);
  await assert.rejects(loadNetworkConnection(f.options,{...f.auth,userId:6}),/Connect your agent/);
  assert.throws(() => networkCredentialDirectory({...f.options,apiUrl:'https://example.com'},f.auth),/Twinkle API/);
  await saveNetworkConnection(f.options,f.auth,{agent:{...agent,handle:'tide_test',id:9},credential});
  await assert.rejects(loadNetworkConnection(f.options,f.auth),/Several agents/);
  assert.equal((await loadNetworkConnection({...f.options,networkOptions:{agent:'tide_test'}},f.auth)).agent.id,9);
  await assert.rejects(saveNetworkConnection(f.options,f.auth,{agent:{...agent,owner:{id:6}},credential}),/invalid connection/);
});
test('join never prints secrets; JSON post uses the selected credential, actual UTF-8 file and stable operation ID',async t => {
  const f = await fixture(t);
  const joined = await run(t,f,['network','join','--handle','ember_test','--name','Ember','--json']);
  assert.equal(joined.code,0,joined.stderr); assert.equal(JSON.parse(joined.stdout).connected,true);
  assert.ok(!joined.stdout.includes(credential.token)); assert.ok(!joined.stderr.includes(credential.token));
  const file = path.join(f.dir,'post.txt'); await fs.writeFile(file,'A curious idea ✦\nSecond line.');
  const posted = await run(t,f,['network','post','--title','Hello','--body-file',file,'--agent','ember_test','--operation-id',operationId,'--json']);
  assert.equal(posted.code,0,posted.stderr);
  assert.equal(JSON.parse(posted.stdout).post.body,'A curious idea ✦\nSecond line.');
  const request = f.requests.find(r => r.path === '/cli/network/post');
  assert.equal(request.agentToken,credential.token); assert.equal(request.body.operationId,operationId);
  assert.equal(request.body.agentId,undefined);
});
test('stdio MCP works headlessly, pins identity, handles invalid input, and returns real request results',async t => {
  const f = await fixture(t); await saveNetworkConnection(f.options,f.auth,{agent,credential});
  const messages = [null,{jsonrpc:'2.0',id:1,method:'initialize'},{jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'network_post',arguments:{title:'MCP post',body:'Agent session content.',operationId}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'network_post',arguments:{title:'Missing receipt',body:'No operation ID'}}}];
  const runResult = await run(t,f,['network','mcp','--agent','ember_test'],messages.map(m => JSON.stringify(m)).join('\n')+'\n');
  assert.equal(runResult.code,0,runResult.stderr);
  const replies = runResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].error.code,-32600);
  assert.match(replies.find(r => r.id === 1).result.instructions,/@ember_test/);
  assert.equal(replies.find(r => r.id === 2).result.tools.length,11);
  assert.equal(replies.find(r => r.id === 3).result.structuredContent.post.id,91);
  assert.equal(replies.find(r => r.id === 4).result.isError,true);
  assert.equal(f.requests.filter(r => r.path === '/cli/network/post').length,1);
  assert.ok(!runResult.stdout.includes(credential.token));
});
test('agent credentials are never forwarded through redirects',async t => {
  const f = await fixture(t); let hits = 0;
  const destination = http.createServer((_req,res) => { hits++; res.end('{}'); }); destination.listen(0,'127.0.0.1'); await once(destination,'listening');
  const source = http.createServer((_req,res) => { res.writeHead(307,{location:`http://127.0.0.1:${destination.address().port}/stolen`}); res.end(); });
  source.listen(0,'127.0.0.1'); await once(source,'listening');
  t.after(() => { source.closeAllConnections(); source.close(); destination.closeAllConnections(); destination.close(); });
  await assert.rejects(callNetwork({...f.options,apiUrl:`http://127.0.0.1:${source.address().port}`},f.auth,{path:'whoami',method:'GET'},{agent,credential}));
  assert.equal(hits,0);
});
test('inbox resume only accepts complete increasing pages; oversized MCP lines recover without retaining the payload',async () => {
  validateInboxPage({events:[{id:2},{id:5}],nextAfter:5,hasMore:true},1);
  assert.throws(() => validateInboxPage({events:[{id:3},{id:2}],nextAfter:2,hasMore:false},1));
  assert.throws(() => validateInboxPage({events:[],nextAfter:99,hasMore:true},1));
  assert.throws(() => validateNetworkTool('network_reply',{postId:1,body:'hello',operationId,agentId:6}),/Unknown argument/);
  const lines = []; for await (const line of boundedLines(Readable.from(['x'.repeat(70000),'y'.repeat(70000),'\n{"ok":true}\n']))) lines.push(line);
  assert.deepEqual(lines,[null,'{"ok":true}']);
});
