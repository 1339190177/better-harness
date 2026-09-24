import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, posix, win32 } from 'node:path';
import { test } from 'node:test';
import afterPack from '../scripts/after-pack.mjs';
import {
  buildChartRuntime, chartAddonName, chartRuntimePaths, chartTargetPlatform,
  installChartRuntime, stageChartRuntime,
} from '../scripts/chart-runtime.mjs';
import {
  chartNoticeName, chartRuntimePackages, collectChartNotices, generateChartNotices, renderChartNotices,
} from '../scripts/chart-notices.mjs';

const target = 'aarch64-apple-darwin';
const licenseText = 'Fixture license grant\nCopyright fixture authors\n';
async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'chart-runtime-packaging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = chartRuntimePaths({ root, target });
  const definitions = [
    ['harness-chart-runtime', '0.1.0', 'LICENSE'], ['napi', '3.0.0', 'LICENSE-MIT'],
    ['renderer', '1.0.0', 'licenses/Apache-2.0.txt'], ['shared', '1.0.0', 'COPYING'],
    ['shared', '2.0.0', 'custom-license.txt'], ['build-only', '1.0.0'], ['dev-only', '1.0.0'],
    ['unused-optional', '1.0.0'], ['other-platform', '1.0.0'],
  ];
  const packages = [];
  for (const [name, version, license] of definitions) {
    const manifest = name === 'harness-chart-runtime' ? paths.manifest
      : join(root, 'registry', `${name}-${version}`, 'Cargo.toml');
    await put(manifest, '[package]\n');
    if (license) await put(join(dirname(manifest), license), licenseText);
    packages.push({ id: `${name}@${version}`, name, version, manifest_path: manifest,
      license: 'MIT', license_file: license === 'custom-license.txt' ? license : null,
      source: name === 'harness-chart-runtime' ? null : 'registry+https://github.com/rust-lang/crates.io-index',
      repository: `https://example.invalid/${name}`, authors: ['Fixture Authors'],
      targets: [{ name: name === 'harness-chart-runtime' ? 'harness_chart_runtime' : name, crate_types: ['cdylib'] }],
    });
  }
  await put(paths.lock, 'version = 4\n');
  const edge = (index, kinds = [null]) => ({ pkg: packages[index].id, name: packages[index].name,
    dep_kinds: kinds.map(kind => ({ kind, target: null })) });
  const nodes = packages.map(pkg => ({ id: pkg.id, deps: [], features: pkg.name === 'napi' ? ['napi8', 'dyn-symbols'] : [] }));
  nodes[0].deps = [edge(1), edge(2), edge(5, ['build']), edge(6, ['dev'])];
  nodes[1].deps = [edge(3)];
  nodes[2].deps = [edge(3), edge(4, ['build', null])];
  nodes[3].deps = [edge(1)];
  const metadata = { packages, workspace_members: [packages[0].id], resolve: { root: packages[0].id, nodes } };
  return { root, paths, metadata };
}

test('目标路径使用显式平台语义，包含 Windows 盘符与 UNC，不依赖宿主分隔符', () => {
  const cases = [
    [posix, '/work/desktop', target, 'darwin', 'libharness_chart_runtime.dylib'],
    [posix, '/work/desktop', 'x86_64-unknown-linux-gnu', 'linux', 'libharness_chart_runtime.so'],
    [win32, 'C:\\work\\desktop', 'x86_64-pc-windows-msvc', 'win32', 'harness_chart_runtime.dll'],
    [win32, '\\\\server\\share\\desktop', 'aarch64-pc-windows-msvc', 'win32', 'harness_chart_runtime.dll'],
  ];
  for (const [path, root, triple, platform, library] of cases) {
    const result = chartRuntimePaths({ root, target: triple, path });
    assert.equal(chartTargetPlatform(triple), platform);
    assert.equal(result.library, path.join(root, 'dist', 'rust', triple, 'release', library));
    assert.equal(result.addon, path.join(root, 'dist', 'native', 'harness-chart-runtime.node'));
    assert.equal(result.notice, path.join(root, 'dist', 'native', 'harness-chart-runtime.NOTICES.txt'));
    assert.equal(result.manifest, path.join(root, 'rust', 'chart-runtime', 'Cargo.toml'));
  }
  for (const invalid of [undefined, '../darwin', 'wasm32-unknown-unknown', 'targets/custom.json']) {
    assert.throws(() => chartTargetPlatform(invalid));
  }
});

test('staging 在三种平台保留动态库字节，只将交付名改为 .node', async t => {
  const { root } = await fixture(t);
  for (const triple of [target, 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
    const paths = chartRuntimePaths({ root, target: triple });
    const bytes = Buffer.from([0, 255, 17, triple.length]);
    await put(paths.library, bytes);
    assert.equal(await stageChartRuntime(paths), paths.addon);
    assert.deepEqual(await readFile(paths.addon), bytes);
  }
});

test('NOTICE 遍历普通运行时依赖闭包、去重环、保留双版本，排除 build/dev/未启用依赖', async t => {
  const { metadata, paths } = await fixture(t);
  assert.deepEqual(chartRuntimePackages(metadata).map(pkg => pkg.id), [
    'harness-chart-runtime@0.1.0', 'napi@3.0.0', 'renderer@1.0.0', 'shared@1.0.0', 'shared@2.0.0',
  ]);
  await put(join(dirname(metadata.packages[2].manifest_path), 'NOTICE.txt'), 'Additional attribution\n');
  const result = await generateChartNotices(metadata, { target, output: paths.notice });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scope, 'normal-dependency-closure');
  assert.equal(result.target, target);
  assert.equal(result.packages.length, 5);
  assert.deepEqual(result.packages[2], {
    name: 'renderer', version: '1.0.0', license: 'MIT',
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    repository: 'https://example.invalid/renderer', authors: ['Fixture Authors'],
    files: [
      { path: 'NOTICE.txt', source: 'crate', text: 'Additional attribution\n' },
      { path: 'licenses/Apache-2.0.txt', source: 'crate', text: licenseText },
    ],
  });
  assert.deepEqual(result.packages[4].files, [{ path: 'custom-license.txt', source: 'crate', text: licenseText }]);
  assert.equal(await readFile(paths.notice, 'utf8'), renderChartNotices(result));
  assert.equal(result.packages.every(pkg => pkg.files.some(file => file.text === licenseText)), true);
});

test('缺少许可证、只有 NOTICE 或只有 SPDX 时明确失败且不生成不完整 artifact', async t => {
  const { metadata, paths } = await fixture(t);
  metadata.resolve.nodes[0].deps.push({ pkg: metadata.packages[5].id, dep_kinds: [{ kind: null, target: null }] });
  await put(join(dirname(metadata.packages[5].manifest_path), 'NOTICE'), 'Attribution without license');
  await assert.rejects(generateChartNotices(metadata, { target, output: paths.notice }), error => {
    assert.equal(error.code, 'CHART_LICENSE_MISSING');
    assert.equal(error.missing.length, 1);
    assert.equal(error.missing[0].includes('build-only@1.0.0'), true);
    return true;
  });
  await assert.rejects(access(paths.notice), { code: 'ENOENT' });
});

test('SPDX fallback 仅允许已核对的仓库/版本/OR 表达式，记录选择与原始来源且优先 crate 文件', async t => {
  const { metadata } = await fixture(t);
  const pkg = metadata.packages[5];
  Object.assign(pkg, { name: 're_renderer', version: '0.37.0',
    repository: 'https://github.com/rerun-io/rerun', license: 'MIT OR Apache-2.0' });
  metadata.resolve.nodes[0].deps.push({ pkg: pkg.id, dep_kinds: [{ kind: null, target: null }] });
  const notices = await collectChartNotices(metadata, { target });
  const entry = notices.packages.find(entry => entry.name === 're_renderer');
  assert.equal(entry.license, 'MIT OR Apache-2.0');
  assert.equal(entry.files.length, 1);
  const file = entry.files[0];
  assert.equal(file.fallback, true);
  assert.equal(file.selectedLicense, 'Apache-2.0');
  assert.equal(file.source, 'https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/Apache-2.0.txt');
  assert.equal(file.path, 'SPDX/Apache-2.0.txt');
  assert.equal(file.text.startsWith('Apache License\nVersion 2.0, January 2004\n'), true);
  assert.equal(file.text.trimEnd().endsWith('limitations under the License.'), true);
  assert.ok(file.text.length > 10000);
  for (const patch of [
    { version: '0.38.0' }, { repository: 'https://example.invalid/rerun' },
    { license: 'MIT AND Apache-2.0' }, { license: 'MIT' }, { name: 'unknown' },
  ]) {
    const original = { ...pkg };
    Object.assign(pkg, patch);
    await assert.rejects(collectChartNotices(metadata, { target }), { code: 'CHART_LICENSE_MISSING' });
    Object.assign(pkg, original);
  }
  await put(join(dirname(pkg.manifest_path), 'LICENSE-APACHE'), licenseText);
  const preferred = await collectChartNotices(metadata, { target });
  assert.deepEqual(preferred.packages.find(entry => entry.name === 're_renderer').files,
    [{ path: 'LICENSE-APACHE', source: 'crate', text: licenseText }]);
});

test('声明的 license_file 不存在以及不完整 resolver 均拒绝静默忽略', async t => {
  const { metadata } = await fixture(t);
  metadata.packages[0].license_file = 'missing.txt';
  await assert.rejects(collectChartNotices(metadata, { target }), { code: 'CHART_LICENSE_MISSING' });
  metadata.resolve.nodes = [];
  assert.throws(() => chartRuntimePackages(metadata));
});

test('独立构建使用同一 locked target metadata 和 Cargo build，生成实际 addon 与完整 NOTICE', async t => {
  const { root, paths, metadata } = await fixture(t);
  const bytes = Buffer.from([202, 254, 186, 190]);
  await put(paths.library, bytes);
  const calls = [];
  const result = await buildChartRuntime({ root, target, run(command, args, options) {
    calls.push({ command, args, options });
    return args[1] === 'metadata' ? JSON.stringify(metadata) : '';
  } });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['cargo', ['+1.96.0', 'metadata', '--locked', '--format-version', '1', '--filter-platform', target, '--manifest-path', paths.manifest]],
    ['cargo', ['+1.96.0', 'build', '--release', '--locked', '--package', 'harness-chart-runtime',
      '--manifest-path', paths.manifest, '--target-dir', paths.targetDirectory, '--target', target]],
  ]);
  assert.equal(calls.every(call => call.options.cwd === root), true);
  assert.deepEqual(await readFile(result.paths.addon), bytes);
  assert.equal(await readFile(result.paths.notice, 'utf8'), renderChartNotices(result.notices));
});

test('--test 执行 Rust 测试但不覆盖 staging，默认 target 从固定工具链解析', async t => {
  const { root, paths, metadata } = await fixture(t);
  const calls = [];
  await buildChartRuntime({ root, test: true, target: '', run(command, args) {
    calls.push([command, args]);
    if (command === 'rustc') return `rustc 1.96.0\r\nhost: ${target}\r\n`;
    return args[1] === 'metadata' ? JSON.stringify(metadata) : '';
  } });
  assert.deepEqual(calls[0], ['rustc', ['+1.96.0', '-vV']]);
  assert.equal(calls[2][1][1], 'test');
  assert.deepEqual(calls[2][1].slice(-2), ['--target', target]);
  await assert.rejects(access(paths.addon), { code: 'ENOENT' });
  await assert.rejects(access(paths.notice), { code: 'ENOENT' });
});

test('禁用 dyn-symbols 或 cargo 失败不能产生可打包的假 addon', async t => {
  const { root, metadata, paths } = await fixture(t);
  metadata.resolve.nodes[1].features = ['napi8'];
  const calls = [];
  await assert.rejects(buildChartRuntime({ root, target, run(command, args) {
    calls.push(args[1]);
    return JSON.stringify(metadata);
  } }));
  assert.deepEqual(calls, ['metadata']);
  metadata.resolve.nodes[1].features.push('dyn-symbols');
  const cargoError = new Error('fixture cargo failure');
  await assert.rejects(buildChartRuntime({ root, target, run(command, args) {
    if (args[1] === 'metadata') return JSON.stringify(metadata);
    throw cargoError;
  } }), error => error === cargoError);
  await assert.rejects(access(paths.addon), { code: 'ENOENT' });
});

test('macOS 实际复制 addon 到 Frameworks、NOTICE 到 Resources/native；缺产物失败', async t => {
  const { root, paths, metadata } = await fixture(t);
  const app = join(root, 'output with spaces', 'Harness Studio.app');
  await put(paths.library, Buffer.from([1, 2, 3, 0]));
  await stageChartRuntime(paths);
  await assert.rejects(installChartRuntime(app, paths.native), { code: 'ENOENT' });
  await generateChartNotices(metadata, { target, output: paths.notice });
  const installed = await installChartRuntime(app, paths.native);
  assert.deepEqual(installed, {
    addon: join(app, 'Contents', 'Frameworks', chartAddonName),
    notice: join(app, 'Contents', 'Resources', 'native', chartNoticeName),
  });
  assert.deepEqual(await readFile(installed.addon), await readFile(paths.library));
  assert.deepEqual(await readFile(installed.notice), await readFile(paths.notice));
});

test('after-pack 正式入口复制真实文件并沿用签名参数，不对 NOTICE 签名', async t => {
  const { root, paths, metadata } = await fixture(t);
  await put(paths.addon, Buffer.from([7, 9, 11, 0]));
  await generateChartNotices(metadata, { target, output: paths.notice });
  for (const service of ['oxc', 'esbuild', 'acp', 'evidence', 'diff', 'arch', 'pty']) {
    for (const suffix of ['client', 'xpc', 'host']) {
      await put(join(paths.native, `harness-${service}-${suffix}`), `fixture ${service} ${suffix}`);
    }
  }
  for (const service of ['esbuild', 'diff']) {
    await put(join(paths.native, `harness-${service}-service.NOTICES.txt`), 'existing notice');
  }
  const context = { electronPlatformName: 'darwin', appOutDir: join(root, 'installer'),
    packager: { appInfo: { productFilename: 'Harness Studio' } } };
  const signatures = [];
  await afterPack(context, { root, run(command, args, options) {
    signatures.push({ command, args, options });
  } });
  const app = join(context.appOutDir, 'Harness Studio.app');
  const addon = join(app, 'Contents', 'Frameworks', chartAddonName);
  const notice = join(app, 'Contents', 'Resources', 'native', chartNoticeName);
  assert.deepEqual(await readFile(addon), await readFile(paths.addon));
  assert.deepEqual(await readFile(notice), await readFile(paths.notice));
  assert.equal(signatures.filter(call => call.args.at(-1) === addon).length, 1);
  assert.equal(signatures.some(call => call.args.at(-1) === notice), false);
  assert.equal(signatures.some(call => call.args.at(-1) === join(app, 'Contents', 'MacOS', 'harness-acp-client')), true);
  for (const call of signatures) {
    assert.equal(call.command, 'codesign');
    assert.deepEqual(call.args.slice(0, 4), ['--force', '--sign', '-', call.args.at(-1)]);
    assert.deepEqual(call.options, { stdio: 'inherit' });
    await access(call.args.at(-1));
  }
  const error = new Error('fixture codesign failed');
  await assert.rejects(afterPack(context, { root, run() { throw error; } }), value => value === error);
  for (const platform of ['win32', 'linux']) {
    await afterPack({ electronPlatformName: platform }, { root, run() { assert.fail('不能调用 macOS 签名'); } });
  }
});

test('解析正式 manifest：Windows/Linux filters 精确交付 addon 与 NOTICE，不携带 Rust cache 或开发 PoC', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.node, '>=22.20.0 <25.0.0');
  assert.equal(manifest.build.npmRebuild, false);
  assert.equal(manifest.scripts['build:rust'], 'node scripts/rust.mjs');
  assert.equal(manifest.scripts['test:rust'], 'node scripts/rust.mjs --test');
  assert.equal(manifest.scripts['build:chart'], 'node scripts/chart-runtime.mjs');
  assert.equal(manifest.scripts['test:chart'], 'node scripts/chart-runtime.mjs --test');
  const hook = await import(new URL(`../${manifest.build.afterPack}`, import.meta.url));
  assert.equal(hook.default, afterPack);
  for (const platform of ['win', 'linux']) {
    const resources = manifest.build[platform].extraResources.find(entry => entry.from === 'dist/native');
    assert.equal(resources.to, 'native');
    const files = [chartAddonName, chartNoticeName, 'libharness_chart_runtime.dylib',
      'harness_chart_runtime.dll', 'libharness_chart_runtime.so', 'rust/cache.bin', 'native-chart-poc.node'];
    const selected = files.filter(file => resources.filter.some(pattern => matchesGlob(file, pattern)));
    assert.deepEqual(selected, [chartAddonName, chartNoticeName]);
  }
});

test('MIT/BSD fallback 保存真实版权归属和来源，不替未知版本生成许可证', async t => {
  const { metadata } = await fixture(t);
  const pkg = metadata.packages[5];
  metadata.resolve.nodes[0].deps.push({ pkg: pkg.id, dep_kinds: [{ kind: null, target: null }] });
  for (const input of [
    { name: 'napi', version: '3.13.0', license: 'MIT', repository: 'https://github.com/napi-rs/napi-rs', holder: 'LongYinan' },
    { name: 'objc2', version: '0.6.4', license: 'MIT', repository: 'https://github.com/madsmtm/objc2', holder: 'Mads Marquart' },
    { name: 'never', version: '0.1.0', license: 'BSD-3-Clause', repository: 'https://fuchsia.googlesource.com/fuchsia/+/master/garnet/lib/rust/never', holder: 'The Fuchsia Authors' },
  ]) {
    Object.assign(pkg, input);
    const notices = await collectChartNotices(metadata, { target });
    const entry = notices.packages.find(entry => entry.name === input.name && entry.version === input.version);
    assert.equal(entry.files[0].selectedLicense, input.license);
    assert.equal(entry.files[0].fallback, true);
    assert.ok(entry.files[0].copyrightSource);
    assert.equal(entry.files[0].text.includes(input.holder), true);
    assert.ok(entry.files[0].text.length > 1000);
    assert.equal(renderChartNotices(notices).includes(`Copyright source: ${entry.files[0].copyrightSource}`), true);
    pkg.version = '99.0.0';
    await assert.rejects(collectChartNotices(metadata, { target }), { code: 'CHART_LICENSE_MISSING' });
  }
});

test('显式验证真实 locked metadata：macOS 完整依赖及 Windows/Linux stub 的 NOTICE 均完整', {
  skip: !process.env.HARNESS_CHART_METADATA_TEST && !process.env.HARNESS_CHART_ADDON,
  timeout: 120_000,
}, async t => {
  const manifest = fileURLToPath(new URL('../rust/chart-runtime/Cargo.toml', import.meta.url));
  for (const triple of [target, 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
    const metadata = JSON.parse(execFileSync('cargo', ['+1.96.0', 'metadata', '--locked', '--format-version', '1',
      '--filter-platform', triple, '--manifest-path', manifest], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const result = await collectChartNotices(metadata, { target: triple });
    assert.equal(result.packages.some(pkg => pkg.name === 'napi'), true);
    assert.equal(result.packages.some(pkg => pkg.name === 'napi-build'), false);
    assert.equal(result.packages.some(pkg => pkg.name === 're_renderer'), triple === target);
    assert.equal(result.packages.every(pkg => pkg.files.length > 0 && pkg.files.every(file => file.text.trim().length > 0)), true);
    t.diagnostic(`${triple}: ${result.packages.length} packages, ${result.packages.filter(pkg => pkg.files.some(file => file.fallback)).length} explicit fallbacks`);
  }
});

test('显式 smoke：真实 addon 在 worker 内从开发与签名后的 macOS 打包路径加载、渲染并释放', {
  skip: !process.env.HARNESS_CHART_ADDON,
  timeout: 60_000,
}, async t => {
  const addon = process.env.HARNESS_CHART_ADDON;
  await access(addon);
  await access(join(dirname(addon), chartNoticeName));
  const addons = [addon];
  if (process.platform === 'darwin') {
    const root = await mkdtemp(join(tmpdir(), 'chart-runtime-real-bundle-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packaged = await installChartRuntime(join(root, 'Harness Chart.app'), dirname(addon));
    execFileSync('codesign', ['--force', '--sign', '-', packaged.addon]);
    execFileSync('codesign', ['--verify', '--strict', packaged.addon]);
    addons.push(packaged.addon);
  }
  for (const addonPath of addons) {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const assert = require('node:assert/strict');
      const { NativeChart } = require(workerData);
      assert.equal(typeof NativeChart, 'function');
      if (process.platform !== 'darwin') {
        assert.throws(() => new NativeChart(64, 64), /UNSUPPORTED/);
        parentPort.postMessage({ available: false, backend: 'unsupported' });
      } else {
        const chart = new NativeChart(64, 64);
        try {
          assert.equal(chart.loadSeries([10, 20, 30], [2, 4, 3]).rawPoints, 3);
          const frame = chart.render();
          assert.equal(frame.rawPoints, 3);
          assert.equal(frame.handle.byteLength, 8);
          assert.equal(chart.releaseFrame(frame.frameId), true);
          assert.equal(chart.stats().inFlight, 0);
          parentPort.postMessage({ available: true, backend: chart.stats().backend });
        } finally { chart.dispose(); }
      }
    `, { eval: true, workerData: addonPath });
    t.after(() => worker.terminate());
    const [result] = await once(worker, 'message');
    assert.equal(result.available, process.platform === 'darwin');
    assert.ok(result.backend);
    t.diagnostic(`${addonPath}: ${JSON.stringify(result)}`);
    await worker.terminate();
  }
});
