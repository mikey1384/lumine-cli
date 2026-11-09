import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { save, versionsCommand, parseArgs } from '../lib/commands.js';

function fixture(t, { publishFailure = false, canPublish = true } = {}) {
  const root = path.resolve('work/save-json-tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const authFile = path.join(dir, 'auth.json');
  const workspace = path.join(dir, 'workspace');
  const build = { id: 2, title: 'Fixture', role: 'owner', canWrite: true, canPublish };
  fs.mkdirSync(path.join(workspace, '.twinkle'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'index.html'), '<p>hello</p>');
  fs.writeFileSync(path.join(workspace, '.twinkle/lumine-project.json'), JSON.stringify({ schemaVersion: 1, buildId: 2, build, filesHash: 'a'.repeat(64), apiUrl: 'https://api.example.test' }));
  fs.writeFileSync(authFile, JSON.stringify({ token: 'fixture-token', apiUrl: 'https://api.example.test' }));
  const output = [], requests = [];
  t.mock.method(console, 'log', line => output.push(String(line)));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const endpoint = new URL(url).pathname; requests.push({ endpoint, body: init?.body });
    let body, status = 200;
    if (endpoint === '/cli/session') body = { userId: 5, scopes: ['build:read', 'build:write'] };
    else if (endpoint === '/cli/build/2/files') body = { build };
    else if (endpoint === '/build/2/project-files') body = { ok: true, success: true, build, artifactVersion: { versionNumber: 12, versionId: 123 }, filesHash: 'b'.repeat(64), projectManifest: { entryPath: '/index.html' } };
    else if (endpoint === '/build/2/publish') {
      status = publishFailure ? 409 : 200;
      body = publishFailure ? { error: 'Review required' } : { build: { ...build, releaseStatus: { state: 'up_to_date' }, publishedArtifactVersionId: 123 } };
    } else if (endpoint === '/cli/build/2/versions') body = { build, versions: [{ version: 12, id: 123 }] };
    else throw new Error('Unexpected fixture request: ' + endpoint);
    return { ok: status === 200, status, text: async () => JSON.stringify(body) };
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { output, requests, workspace, options: (command, extra = []) => parseArgs([command, '--dir', workspace, '--auth-file', authFile, '--api-url', 'https://api.example.test', '--no-update-check', '--json', ...extra]) };
}

test('save --json emits one parseable canonical receipt and preserves the new workspace base', async t => {
  const f = fixture(t);
  await save(f.options('save'));
  assert.equal(f.output.length, 1);
  const result = JSON.parse(f.output[0]);
  assert.equal(result.ok, true); assert.equal(result.artifactVersion.versionId, 123);
  assert.equal(result.filesHash, 'b'.repeat(64)); assert.equal(result.publication, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, '.twinkle/lumine-project.json'))).filesHash, result.filesHash);
  const sent = JSON.parse(f.requests.find(r => r.endpoint === '/build/2/project-files').body);
  assert.equal(sent.baseFilesHash, 'a'.repeat(64));
});

test('save --json --publish reports canonical publication in the same receipt', async t => {
  const f = fixture(t);
  await save(f.options('save', ['--publish']));
  assert.equal(f.output.length, 1);
  const result = JSON.parse(f.output[0]);
  assert.equal(result.publication.published, true);
  assert.equal(result.build.publishedArtifactVersionId, 123);
});

test('publication refusal retains the successful save receipt but still fails the command', async t => {
  const f = fixture(t, { publishFailure: true });
  await assert.rejects(save(f.options('save', ['--publish'])), /Review required/);
  assert.equal(f.output.length, 1);
  const result = JSON.parse(f.output[0]);
  assert.equal(result.ok, false); assert.equal(result.artifactVersion.versionId, 123);
  assert.equal(result.publication.published, false);
});

test('a contribution save cannot claim publication or send the publish request', async t => {
  const f = fixture(t, { canPublish: false });
  await save(f.options('save', ['--publish']));
  const result = JSON.parse(f.output[0]);
  assert.equal(result.publication.published, false);
  assert.equal(f.requests.some(r => r.endpoint.endsWith('/publish')), false);
});

test('versions --json returns the canonical history with no prose', async t => {
  const f = fixture(t);
  await versionsCommand(f.options('versions'));
  assert.equal(f.output.length, 1);
  assert.deepEqual(JSON.parse(f.output[0]).versions, [{ version: 12, id: 123 }]);
});

// 11-09: #363 v230 carried 33 `lumine admin` receipts an older CLI wrote into
// the workspace's work/lumine-admin/. Save (and launch / save --publish, which
// save the same way) never uploads that folder, at any depth, and says so once.
test('save never uploads CLI admin state left in the workspace, and warns once', async t => {
  const f = fixture(t);
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(f.workspace, relative)), { recursive: true });
    fs.writeFileSync(path.join(f.workspace, relative), content);
  };
  write('work/lumine-admin/requests/abc.receipt.json', '{"ok":true,"status":"success"}');
  write('work/lumine-admin/requests/abc.pending.json', '{}');
  write('src/work/lumine-admin/requests/def.receipt.json', '{"ok":true}');
  // An app's own work/ folder is still the app's.
  write('work/notes.js', 'export const notes = 1;');
  write('src/lumine-admin/panel.js', 'export const panel = 1;');
  const warnings = [];
  t.mock.method(console, 'error', line => warnings.push(String(line)));
  await save(f.options('save', ['--publish']));
  const sent = JSON.parse(f.requests.find(r => r.endpoint === '/build/2/project-files').body);
  const paths = sent.files.map(file => file.path).sort();
  assert.deepEqual(paths, ['/index.html', '/src/lumine-admin/panel.js', '/work/notes.js']);
  assert.equal(JSON.parse(f.output[0]).publication.published, true);
  const skipped = warnings.filter(line => /skipping .*lumine-admin\//.test(line));
  assert.deepEqual(skipped.map(line => line.match(/skipping (\S+)/)[1]).sort(), ['src/work/lumine-admin/', 'work/lumine-admin/']);
  // A second save in the same run does not repeat the warning.
  await save(f.options('save'));
  assert.equal(warnings.filter(line => /skipping .*lumine-admin\//.test(line)).length, 2);
});
