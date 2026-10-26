const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {manifest, artifact, repository, downloadUrl} = require('../scripts/release.cjs');
const config = JSON.parse(readFileSync(resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'));
const repo = repository(config);
assert.equal(repo, 'Auralisys/aurachat');
assert.equal(downloadUrl(config, 'AuraChat setup.exe'),
  `https://github.com/${repo}/releases/download/v${config.version}/AuraChat%20setup.exe`);
assert.ok(!downloadUrl(config, 'package.exe').includes('untagged-'));
const api = id => `https://github.com/${repo}/releases/download/v${config.version}/package-${id}.exe`;
const first = manifest(config, 'windows-x86_64', api(123), 'signature-windows');
const combined = manifest(config, 'darwin-aarch64', api(456), 'signature-mac', first);
assert.deepEqual(Object.keys(combined.platforms), ['windows-x86_64', 'darwin-aarch64']);
assert.equal(combined.platforms['windows-x86_64'].signature, 'signature-windows');
assert.equal(combined.pub_date, first.pub_date);
assert.equal(combined.version, config.version);
assert.throws(() => manifest(config, 'darwin-aarch64', api(456), '', first), /signed asset/);
assert.throws(() => manifest(config, 'darwin-aarch64', api(456), 'sig', {...first, version: '0.0.0'}), /different versions/);
for (const bad of [
  'https://example.com/app.exe', `${api(123)}?token=secret`,
  'https://api.github.com/repos/other/repo/releases/assets/123',
  `https://user:secret@api.github.com/repos/${repo}/releases/assets/123`,
]) assert.throws(() => manifest(config, 'windows-x86_64', bad, 'sig'), /signed asset/);
assert.equal(artifact(config, 'win32', 'x64').target, 'windows-x86_64');
assert.equal(artifact(config, 'darwin', 'arm64').target, 'darwin-aarch64');
assert.equal(artifact(config, 'darwin', 'x64').target, 'darwin-x86_64');
assert.throws(() => artifact(config, 'linux', 'x64'), /Windows or macOS/);
assert.equal(config.bundle.createUpdaterArtifacts, true);
assert.ok(config.plugins.updater.windows.installerArgs.includes('/NS'));
assert.equal(config.plugins.updater.windows.installMode, 'passive');
assert.equal(config.bundle.publisher, 'Auralisys');
assert.equal(config.bundle.windows.nsis.installerIcon, 'icons/windows/icon.ico');
assert.equal(config.bundle.windows.nsis.uninstallerIcon, 'icons/windows/icon.ico');
assert.deepEqual(config.bundle.windows.nsis.languages, ['English', 'Italian']);
for (const [setting, width, height] of [['headerImage', 150, 57], ['sidebarImage', 164, 314]]) {
  const bitmap = readFileSync(resolve(__dirname, '../src-tauri', config.bundle.windows.nsis[setting]));
  assert.equal(bitmap.toString('ascii', 0, 2), 'BM');
  assert.equal(bitmap.readInt32LE(18), width);
  assert.equal(bitmap.readInt32LE(22), height);
  assert.equal(bitmap.readUInt16LE(28), 24);
}
assert.ok(readFileSync(resolve(__dirname, '../src-tauri/Cargo.toml'), 'utf8').includes(`version = "${config.version}"`));
const installer = readFileSync(resolve(__dirname, '../scripts/install-prod.ps1'), 'utf8');
assert.ok(installer.includes("'/UPDATE', '/NS'"));
console.log('PASS: signed cross-platform manifests, merge/version checks, asset URL restrictions, NSIS no-shortcut configuration.');
