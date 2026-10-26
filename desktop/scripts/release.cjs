// Local-only builds. GitHub is used for hosting, never for compilation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');

const desktop = path.resolve(__dirname, '..');
const configPath = path.join(desktop, 'src-tauri', 'tauri.conf.json');
const cargoPath = path.join(desktop, 'src-tauri', 'Cargo.toml');
const output = path.join(desktop, 'src-tauri', 'target', 'release', 'updater');

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: desktop, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args[0]} failed: ${(result.stderr || '').trim() || result.status}`);
  return (result.stdout || '').trim();
}

function repository(config) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/latest\/download\/latest\.json$/.exec(config.plugins.updater.endpoints[0]);
  if (!match) throw new Error('Configure a public GitHub latest/download/latest.json endpoint in tauri.conf.json.');
  return match[1];
}

function bumpVersion(config, kind) {
  if (!['patch', 'minor', 'major'].includes(kind)) throw new Error('--bump expects patch, minor or major.');
  const parts = config.version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Use a stable major.minor.patch version.');
  const i = {major: 0, minor: 1, patch: 2}[kind];
  parts[i]++;
  for (let j = i + 1; j < 3; j++) parts[j] = 0;
  const next = parts.join('.');
  const cargo = fs.readFileSync(cargoPath, 'utf8');
  if (!cargo.includes(`version = "${config.version}"`)) throw new Error('Cargo and Tauri versions differ.');
  fs.writeFileSync(cargoPath, cargo.replace(`version = "${config.version}"`, `version = "${next}"`));
  config.version = next;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function signingEnvironment() {
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY || path.join(os.homedir(), '.tauri', 'AuraChat', 'updater.key');
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !fs.existsSync(key)) {
    throw new Error('Signing key missing. Restore the existing AuraChat key on this machine; never generate a replacement for an installed release.');
  }
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(key + '.pub')) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (fs.readFileSync(key + '.pub', 'utf8').trim() !== config.plugins.updater.pubkey.trim()) {
      throw new Error('The local signing key does not match the public key embedded in AuraChat.');
    }
  }
  return {...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || ''};
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceFingerprint() {
  const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.']).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file + '\0');
    const absolute = path.join(desktop, file);
    hash.update(fs.existsSync(absolute) ? fs.readFileSync(absolute) : '<deleted>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function credentialEnvironment(repo) {
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GCM_GUI_PROMPT: 'false'};
  const candidates = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
  const result = spawnSync('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], {
    env, input: `protocol=https\nhost=github.com\npath=${repo}.git\n\n`,
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  if (result.status === 0) candidates.push(result.stdout.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9));
  const gh = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], {env, encoding: 'utf8', windowsHide: true, timeout: 5000});
  if (gh.status === 0) candidates.push(gh.stdout.trim());
  for (const token of candidates.filter(Boolean)) {
    const candidate = {...env, GH_TOKEN: token};
    const probe = spawnSync('gh', ['api', `repos/${repo}`, '--jq', '.permissions.push'], {env: candidate, encoding: 'utf8', windowsHide: true, timeout: 20_000});
    if (probe.status === 0 && probe.stdout.trim() === 'true') return candidate;
  }
  throw new Error(`No GitHub credential with write access to ${repo}. GitHub Desktop login may not be available to Git Credential Manager/gh. No release was published.`);
}

function artifact(config, platform = process.platform, arch = process.arch) {
  const version = config.version;
  const release = path.join(desktop, 'src-tauri', 'target', 'release', 'bundle');
  if (platform === 'win32' && ['x64', 'arm64'].includes(arch)) {
    const cpu = arch === 'x64' ? 'x64' : 'arm64';
    return {target: `windows-${arch === 'x64' ? 'x86_64' : 'aarch64'}`, file: path.join(release, 'nsis', `AuraChat_${version}_${cpu}-setup.exe`)};
  }
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) {
    return {target: `darwin-${arch === 'x64' ? 'x86_64' : 'aarch64'}`, file: path.join(release, 'macos', 'AuraChat.app.tar.gz')};
  }
  throw new Error('Build on Windows or macOS with x64/arm64. Cross-building macOS from Windows is not supported.');
}

function manifest(config, target, url, signature, previous) {
  if (previous && previous.version !== config.version) throw new Error('Cannot merge manifests from different versions.');
  const repo = repository(config);
  for (const entry of [...Object.values(previous?.platforms || {}), {url, signature}]) {
    const parsed = new URL(entry.url);
    const publicDownload = parsed.origin === 'https://github.com' && parsed.pathname.startsWith(`/${repo}/releases/download/v${config.version}/`);
    if (!publicDownload || parsed.search || parsed.hash || parsed.username || parsed.password || !entry.signature?.trim()) {
      throw new Error('Manifest requires a signed asset in the configured GitHub repository.');
    }
  }
  return {
    version: config.version,
    notes: previous?.notes || `AuraChat ${config.version}`,
    pub_date: previous?.pub_date || new Date().toISOString(),
    platforms: {...previous?.platforms, [target]: {url, signature: signature.trim()}},
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node desktop\\scripts\\release.cjs [--bump patch|minor|major] [--publish] [--skip-build]\nBuilds and signs locally; writes latest.json. --publish explicitly uploads a GitHub release. Does not commit or push source.');
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bump') { i++; if (!args[i]) throw new Error('--bump needs a value.'); }
    else if (!['--publish', '--skip-build'].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  }
  if (args.includes('--bump') && args.includes('--skip-build')) throw new Error('Cannot bump a version while reusing old artifacts.');
  if (args.includes('--bump') && args.includes('--publish')) throw new Error('Prepare the version first, then commit/push it before --publish.');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const repo = repository(config);
  const publish = args.includes('--publish');
  // Fail before modifying versions or doing expensive work if publishing is unavailable.
  const env = publish ? credentialEnvironment(repo) : process.env;
  if (publish && run('git', ['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Commit and push the intended source/version changes before publishing. The script never commits or pushes for you.');
  }
  if (args.includes('--bump')) bumpVersion(config, args[args.indexOf('--bump') + 1]);
  const cargo = fs.readFileSync(cargoPath, 'utf8');
  if (!cargo.includes(`version = "${config.version}"`)) throw new Error('Cargo and Tauri versions differ.');
  const item = artifact(config);
  const receiptPath = path.join(output, 'build-receipt.json');
  if (args.includes('--skip-build')) {
    if (!fs.existsSync(receiptPath)) throw new Error('No verified build receipt. Run without --skip-build first.');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.version !== config.version || receipt.target !== item.target || receipt.source !== sourceFingerprint()
        || !fs.existsSync(item.file) || !fs.existsSync(item.file + '.sig')
        || receipt.installer !== digest(item.file) || receipt.signature !== digest(item.file + '.sig')) {
      throw new Error('Sources, version or artifacts changed since the last build. Run without --skip-build.');
    }
  }
  if (!args.includes('--skip-build')) {
    const buildArgs = ['tauri', 'build', '--bundles', process.platform === 'darwin' ? 'app,dmg' : 'nsis'];
    if (process.platform === 'darwin') buildArgs.push('--config', 'src-tauri/tauri.macos.conf.json');
    run('cargo', buildArgs, {env: {...signingEnvironment(), ...env}, stdio: 'inherit', timeout: undefined});
  }
  if (!fs.existsSync(item.file) || !fs.existsSync(item.file + '.sig')) throw new Error('Signed installer missing. Build this version first.');
  fs.mkdirSync(output, {recursive: true});
  fs.writeFileSync(receiptPath, JSON.stringify({
    version: config.version, target: item.target, source: sourceFingerprint(),
    installer: digest(item.file), signature: digest(item.file + '.sig'),
  }, null, 2) + '\n');
  const filename = process.platform === 'darwin' ? `AuraChat_${config.version}_${item.target}.app.tar.gz` : path.basename(item.file);
  const installer = path.join(output, filename);
  fs.copyFileSync(item.file, installer);
  fs.copyFileSync(item.file + '.sig', installer + '.sig');
  const signature = fs.readFileSync(installer + '.sig', 'utf8');
  const manifestPath = path.join(output, 'latest.json');
  let latest = manifest(config, item.target, `https://github.com/${repo}/releases/download/v${config.version}/${filename}`, signature);
  fs.writeFileSync(manifestPath, JSON.stringify(latest, null, 2) + '\n');
  console.log(`Signed package and latest.json: ${output}`);
  if (!publish) {console.log('Local preparation only: nothing uploaded.'); return;}

  const api = (route, extra = []) => run('gh', ['api', route, ...extra], {env});
  const sourceCommit = run('git', ['rev-parse', 'HEAD']);
  const remoteCommit = JSON.parse(api(`repos/${repo}/commits/${sourceCommit}`));
  if (remoteCommit.sha !== sourceCommit) throw new Error('Push the source commit using GitHub Desktop before publishing.');
  const tag = `v${config.version}`;
  const releases = JSON.parse(api(`repos/${repo}/releases?per_page=100`));
  let release = releases.find(release => release.tag_name === tag);
  if (!release) {
    // This creates a remote tag/release only when --publish was explicitly requested.
    run('gh', ['release', 'create', tag, '--repo', repo, '--target', sourceCommit, '--draft', '--title', `AuraChat ${config.version}`, '--notes', `AuraChat ${config.version}`], {env});
    const drafts = JSON.parse(api(`repos/${repo}/releases?per_page=100`));
    release = drafts.find(release => release.tag_name === tag);
    if (!release) throw new Error('Created draft could not be found.');
  }
  if (release.assets.some(asset => asset.name === filename)) throw new Error('This platform/version already exists. Increment the version; published binaries are immutable.');
  const publishedTag = JSON.parse(api(`repos/${repo}/commits/${release.draft ? release.target_commitish : tag}`));
  if (publishedTag.sha !== sourceCommit) throw new Error('Windows and macOS must publish the same source commit.');
  const existing = release.assets.find(asset => asset.name === 'latest.json');
  let previous;
  if (existing) {
    previous = JSON.parse(api(`repos/${repo}/releases/assets/${existing.id}`, ['-H', 'Accept: application/octet-stream']));
    if (previous.platforms?.[item.target]) throw new Error('This platform is already published. Bump the version instead of replacing it.');
  }
  run('gh', ['release', 'upload', tag, installer, installer + '.sig', '--repo', repo], {env, timeout: 600_000});
  release = JSON.parse(api(`repos/${repo}/releases/${release.id}`));
  const uploaded = release.assets.find(asset => asset.name === filename);
  if (!uploaded) throw new Error('Uploaded installer could not be verified.');
  latest = manifest(config, item.target, uploaded.browser_download_url, signature, previous);
  fs.writeFileSync(manifestPath, JSON.stringify(latest, null, 2) + '\n');
  run('gh', ['release', 'upload', tag, manifestPath, '--repo', repo, '--clobber'], {env});
  run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'], {env});
  const verified = JSON.parse(api(`repos/${repo}/releases/tags/${tag}`));
  const remoteManifest = verified.assets.find(asset => asset.name === 'latest.json');
  if (!remoteManifest) throw new Error('Published manifest missing.');
  const remote = JSON.parse(api(`repos/${repo}/releases/assets/${remoteManifest.id}`, ['-H', 'Accept: application/octet-stream']));
  if (JSON.stringify(remote) !== JSON.stringify(latest)) throw new Error('Remote manifest does not match the uploaded version.');
  console.log(`Published and verified: ${verified.html_url}`);
}

module.exports = {repository, manifest, artifact};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
