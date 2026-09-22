import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';

/** Renderer JavaScript is bundled, so preserve notices separately from node_modules. */
export function stageNotices(buildPath) {
  const desktop = resolve(import.meta.dirname, '..'), root = resolve(desktop, '../..');
  const output = join(buildPath, 'notices'); mkdirSync(output, { recursive: true });
  for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, name), join(output, name));
  const seen = new Set(), packages = [];
  function visit(name, from) {
    const require = createRequire(join(from, 'package.json'));
    let source;
    for (const parent of require.resolve.paths(name + '/package.json') ?? []) {
      try { const file = join(parent, name, 'package.json'); if (JSON.parse(readFileSync(file, 'utf8')).name === name) { source = dirname(realpathSync(file)); break; } } catch {}
    }
    if (!source) throw Error('Missing dependency notice source: ' + name);
    if (seen.has(source)) return; seen.add(source);
    const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (name === '@estacoda/control-protocol') return; // covered by root Apache-2.0 notices
    const key = name.replaceAll('/', '__') + '@' + metadata.version;
    const texts = readdirSync(source).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file));
    if (!texts.length) throw Error('Review missing bundled dependency license: ' + name);
    const target = join(output, key); mkdirSync(target, { recursive: true });
    for (const file of texts) cpSync(join(source, file), join(target, file), { recursive: true, dereference: true });
    packages.push({ name, version: metadata.version, license: metadata.license ?? 'SEE LICENSE FILE', files: texts.map(file => key + '/' + file) });
    for (const child of Object.keys(metadata.dependencies ?? {})) visit(child, source);
  }
  const dependencies = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).dependencies;
  for (const name of Object.keys(dependencies)) visit(name, desktop);
  const require = createRequire(join(desktop, 'package.json'));
  const electron = dirname(require.resolve('electron/package.json'));
  for (const file of ['LICENSE', 'LICENSES.chromium.html']) cpSync(join(electron, 'dist', file), join(output, 'electron-' + file));
  cpSync(resolve(process.execPath, '../../LICENSE'), join(output, 'node-LICENSE'));
  writeFileSync(join(output, 'inventory.json'), JSON.stringify({ node: process.version, electron: JSON.parse(readFileSync(join(electron, 'package.json'), 'utf8')).version, packages: packages.sort((a, b) => a.name.localeCompare(b.name)), core: 'Core dependency licenses are preserved with packages under .runtime/core/node_modules; core LICENSE and NOTICE under .runtime/core.' }, null, 2));
}
