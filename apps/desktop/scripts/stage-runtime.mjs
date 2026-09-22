// Stage the build-machine's owned Node and production dependency closure. Never
// resolve an executable at runtime from PATH or accept a renderer-supplied path.
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {inventoryRuntime,runtimeDigest} from '../src/main/runtime-integrity.ts';
const root = resolve(import.meta.dirname, '../../..');
const output = resolve(import.meta.dirname, '../.runtime');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const [platform=process.platform,arch=process.arch]=process.argv.slice(2);
if(platform!==process.platform||arch!==process.arch)throw new Error('Package on a native runner matching the requested OS and architecture.');
// Packaging must never silently reuse a distribution from an older checkout.
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build'], {cwd:root,stdio:'inherit'});
if (!readFileSync(join(root, 'dist/index.js'), 'utf8').includes('desktop-service')) throw new Error('Build the core distribution first.');
rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
const executable = join(output, process.platform === 'win32' ? 'node.exe' : 'node');
cpSync(process.execPath, executable); chmodSync(executable, 0o755);
for (const entry of packageJson.files) {
  if (entry === 'package.json') continue;
  cpSync(join(root, entry), join(output, 'core', entry), { recursive: true, dereference: true });
}
writeFileSync(join(output, 'core/package.json'), JSON.stringify({ ...packageJson, scripts: {}, devDependencies: {} }, null, 2));
const copied = new Set();
function dependency(name, from, destination, optional = false) {
  const require = createRequire(join(from, 'package.json'));
  let source;
  // Resolve dependency metadata even when package exports hide its root.
  for (const search of require.resolve.paths(name + '/package.json') ?? []) {
    try {
      const candidate = join(search, name, 'package.json');
      if (JSON.parse(readFileSync(candidate, 'utf8')).name === name) { source = candidate; break; }
    } catch {}
  }
  if (!source) { if (optional) return; throw new Error('Missing runtime dependency: ' + name); }
  const directory = dirname(realpathSync(source));
  const target = join(destination, 'node_modules', name);
  if (copied.has(target)) return;
  copied.add(target);
  // No pnpm links escape the relocatable runtime. Nested closures preserve versions.
  cpSync(directory, target, { recursive: true, dereference: true, filter: path => !path.includes('/node_modules/', directory.length) });
  const metadata = JSON.parse(readFileSync(source, 'utf8'));
  for (const child of Object.keys(metadata.dependencies ?? {})) dependency(child, directory, target);
  for (const child of Object.keys(metadata.optionalDependencies ?? {})) dependency(child, directory, target, true);
}
for (const name of Object.keys(packageJson.dependencies)) dependency(name, root, join(output, 'core'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
// Verify standalone Node ABI now; Electron never rebuilds this native module.
execFileSync(executable, ['--input-type=module', '-e', "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.close();"], { cwd: join(output, 'core'), env: { PATH: dirname(executable) } });
// Exercise both native Node dependencies with the staged executable and closure.
execFileSync(executable, ['--input-type=module', '-e', "import sharp from 'sharp'; const image=await sharp({create:{width:1,height:1,channels:4,background:'#fff'}}).png().toBuffer(); if(!image.length)throw new Error('Image ABI unavailable');"], {cwd:join(output,'core'),env:{PATH:dirname(executable)}});
const files=inventoryRuntime(output);
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ version: 2, platform: process.platform, arch: process.arch, nodeVersion: process.version, coreVersion: packageJson.version, nodeSha256: digest(executable), entrySha256: digest(join(output, 'core/dist/index.js')), runtimeSha256:runtimeDigest(files), files }, null, 2));
console.log('Staged owned Node runtime and verified standalone SQLite and image-processing ABIs.');
