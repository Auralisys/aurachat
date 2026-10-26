const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function testPublish(existingWindows) {
  const script = path.resolve(__dirname, '../scripts/release.cjs');
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'));
  const repo = 'Auralisys/aurachat';
  const tag = `v${config.version}`;
  const commit = 'a'.repeat(40);
  const filename = `AuraChat_${config.version}_x64-setup.exe`;
  const prefix = `https://github.com/${repo}/releases/download/`;
  const previous = {
    version: config.version, notes: 'Existing Mac', pub_date: '2026-01-01T00:00:00Z',
    platforms: {'darwin-aarch64': {url: `${prefix}${tag}/mac.app.tar.gz`, signature: 'mac-signature'}},
  };
  let release;
  if (existingWindows) {
    release = {id: 1, tag_name: tag, draft: false, target_commitish: commit,
      assets: [{id: 8, name: 'latest.json'}]};
  }
  const files = new Map();
  let polls = 0;
  let uploadedManifest;
  let usedStoredCredential = false;
  let finished;
  const completion = new Promise(resolve => { finished = resolve; });
  const success = value => ({status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value)});
  const fakeFs = {
    existsSync: file => !file.endsWith('updater.key.pub'),
    mkdirSync() {},
    copyFileSync() {},
    writeFileSync: (file, content) => files.set(file, content),
    readFileSync(file) {
      if (files.has(file)) return files.get(file);
      if (file.endsWith('tauri.conf.json')) return JSON.stringify(config);
      if (file.endsWith('Cargo.toml')) return `version = "${config.version}"`;
      return file.endsWith('.sig') ? 'windows-signature' : 'source-or-binary';
    },
  };
  function spawnSync(program, args, options) {
    if (program === 'cargo') return success('');
    if (program === 'git') {
      if (args.includes('fill')) return {status: 1};
      if (args[0] === 'status') return success('');
      if (args[0] === 'rev-parse') return success(commit);
      if (args[0] === 'ls-files') return success('scripts/release.cjs\0');
    }
    if (program === 'gh') {
      if (args[0] === 'auth') {
        assert.equal(options.env.GH_TOKEN, undefined, 'stored login must not inherit session token');
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        return success('stored-token');
      }
      if (args[0] === 'api') {
        const route = args[1];
        if (route === `repos/${repo}`) {
          usedStoredCredential ||= options.env.GH_TOKEN === 'stored-token';
          return success(options.env.GH_TOKEN === 'stored-token' ? 'true' : 'false');
        }
        assert.equal(options.env.GH_TOKEN, 'stored-token');
        if (route.includes('/commits/')) return success({sha: commit});
        if (route.includes('/releases?')) {
          polls++;
          return success(release && (existingWindows || polls > 2) ? [release] : []);
        }
        if (route.endsWith('/releases/1')) return success(release);
        if (route.endsWith('/releases/assets/8')) return success(uploadedManifest || previous);
        if (route.includes('/releases/tags/')) return success({...release, html_url: 'https://github.com/example/release'});
      }
      if (args[0] === 'release' && args[1] === 'create') {
        release = {id: 1, tag_name: tag, target_commitish: commit, draft: true, assets: []};
        return success('');
      }
      if (args[0] === 'release' && args[1] === 'upload') {
        if (args[3].endsWith('latest.json')) {
          uploadedManifest = JSON.parse(files.get(args[3]));
          if (!release.assets.some(asset => asset.name === 'latest.json')) release.assets.push({id: 8, name: 'latest.json'});
        } else {
          release.assets.push({name: filename, browser_download_url: `${prefix}untagged-temporary/${filename}`});
        }
        return success('');
      }
      if (args[0] === 'release' && args[1] === 'edit') {
        release.draft = false;
        return success('');
      }
    }
    throw new Error(`Unexpected command: ${program} ${args.join(' ')}`);
  }
  const sandbox = {
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return {spawnSync};
      return require(name);
    },
    module: {exports: {}}, __dirname: path.dirname(script), URL,
    process: {argv: ['node', script, '--publish'], platform: 'win32', arch: 'x64',
      env: {GH_TOKEN: 'read-only-session', GITHUB_TOKEN: 'also-read-only'}},
    console: {
      log(message) { if (message.startsWith('Published and verified:')) finished(); },
      error(message) { finished(new Error(message)); },
    },
    setTimeout: resolve => { resolve(); },
  };
  sandbox.require.main = sandbox.module;
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, {filename: script});
  const error = await completion;
  if (error) throw error;
  assert.ok(usedStoredCredential);
  assert.equal(release.draft, false);
  assert.equal(uploadedManifest.platforms['windows-x86_64'].url, `${prefix}${tag}/${filename}`);
  if (existingWindows) {
    assert.equal(uploadedManifest.platforms['darwin-aarch64'].signature, 'mac-signature');
    assert.equal(uploadedManifest.pub_date, previous.pub_date);
  } else {
    assert.ok(polls >= 3, 'new draft must survive temporarily stale list responses');
  }
}

(async () => {
  await testPublish(false);
  await testPublish(true);
  console.log('PASS: draft polling, canonical URLs, stored credentials and cross-platform publication merge.');
})().catch(error => { console.error(error); process.exitCode = 1; });
