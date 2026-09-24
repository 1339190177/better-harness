import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir } from 'node:fs/promises';
import * as hostPath from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chartNoticeName, chartRuntimePackages, generateChartNotices } from './chart-notices.mjs';

const desktopRoot = hostPath.resolve(hostPath.dirname(fileURLToPath(import.meta.url)), '..');
export const chartAddonName = 'harness-chart-runtime.node';
const toolchain = '+1.96.0';

export function chartTargetPlatform(target) {
  if (!/^[a-z0-9_]+(?:-[a-z0-9_]+)+$/.test(target ?? '')) {
    throw new Error(`chart-runtime 需要标准 Rust target triple：${target}`);
  }
  if (target.endsWith('-apple-darwin')) return 'darwin';
  if (target.includes('-windows-')) return 'win32';
  if (target.includes('-linux-')) return 'linux';
  throw new Error(`chart-runtime 不支持此构建目标：${target}`);
}

export function chartRuntimePaths({ root = desktopRoot, target, path = hostPath }) {
  const platform = chartTargetPlatform(target);
  const library = platform === 'win32' ? 'harness_chart_runtime.dll'
    : platform === 'darwin' ? 'libharness_chart_runtime.dylib' : 'libharness_chart_runtime.so';
  root = path.resolve(root);
  const targetDirectory = path.join(root, 'dist', 'rust');
  const native = path.join(root, 'dist', 'native');
  return {
    manifest: path.join(root, 'rust', 'chart-runtime', 'Cargo.toml'),
    lock: path.join(root, 'rust', 'chart-runtime', 'Cargo.lock'),
    targetDirectory, native,
    library: path.join(targetDirectory, target, 'release', library),
    addon: path.join(native, chartAddonName), notice: path.join(native, chartNoticeName),
  };
}

export async function stageChartRuntime(paths) {
  await mkdir(paths.native, { recursive: true });
  await copyFile(paths.library, paths.addon);
  return paths.addon;
}

/** macOS 的代码与声明分别进入 Frameworks 和 Resources，不进入 app.asar。 */
export async function installChartRuntime(app, native) {
  const addon = hostPath.join(app, 'Contents', 'Frameworks', chartAddonName);
  const notice = hostPath.join(app, 'Contents', 'Resources', 'native', chartNoticeName);
  // 缺失任一构建产物时直接失败，不能静默打出缺少运行时的安装包。
  await access(hostPath.join(native, chartAddonName));
  await access(hostPath.join(native, chartNoticeName));
  await mkdir(hostPath.dirname(addon), { recursive: true });
  await mkdir(hostPath.dirname(notice), { recursive: true });
  await copyFile(hostPath.join(native, chartAddonName), addon);
  await copyFile(hostPath.join(native, chartNoticeName), notice);
  return { addon, notice };
}

function validateAddonMetadata(metadata, manifest) {
  const packages = chartRuntimePackages(metadata);
  const root = packages.find(pkg => pkg.name === 'harness-chart-runtime');
  if (hostPath.resolve(root.manifest_path) !== hostPath.resolve(manifest)
    || !root.targets.some(target => target.name === 'harness_chart_runtime' && target.crate_types.includes('cdylib'))) {
    throw new Error('chart-runtime 必须使用 Desktop crate 的 harness_chart_runtime cdylib');
  }
  const napi = packages.find(pkg => pkg.name === 'napi');
  const node = metadata.resolve.nodes.find(node => node.id === napi?.id);
  if (!node?.features.includes('dyn-symbols')) {
    throw new Error('chart-runtime 必须启用 napi dyn-symbols，不使用 npm rebuild 或 Electron ABI 重编译');
  }
}

export async function buildChartRuntime({
  root = desktopRoot, test = false, target = process.env.CARGO_BUILD_TARGET, run = execFileSync,
} = {}) {
  root = hostPath.resolve(root);
  if (!target) {
    const version = run('rustc', [toolchain, '-vV'], { cwd: root, encoding: 'utf8' });
    target = version.split(/\r?\n/).find(line => line.startsWith('host: '))?.slice(6).trim();
  }
  const paths = chartRuntimePaths({ root, target });
  await access(paths.manifest);
  await access(paths.lock);
  const metadata = JSON.parse(run('cargo', [toolchain, 'metadata', '--locked', '--format-version', '1',
    '--filter-platform', target, '--manifest-path', paths.manifest],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  validateAddonMetadata(metadata, paths.manifest);
  run('cargo', [toolchain, test ? 'test' : 'build', '--release', '--locked',
    '--package', 'harness-chart-runtime', '--manifest-path', paths.manifest,
    '--target-dir', paths.targetDirectory, '--target', target], { cwd: root, stdio: 'inherit' });
  if (test) return { target, paths };
  const notices = await generateChartNotices(metadata, { target, output: paths.notice });
  await stageChartRuntime(paths);
  return { target, paths, notices };
}

if (process.argv[1] && hostPath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    test: { type: 'boolean' }, target: { type: 'string' }, smoke: { type: 'boolean' },
  } });
  if (values.test && values.smoke) throw new Error('--smoke 需要构建 addon，不能与 --test 同用');
  const result = await buildChartRuntime({ test: values.test, target: values.target });
  console.log(values.test ? `chart-runtime Rust 测试完成：${result.target}`
    : `chart-runtime 已构建：${result.paths.addon}\nNOTICE：${result.paths.notice}`);
  if (values.smoke) {
    execFileSync(process.execPath, ['--test', hostPath.join(desktopRoot, 'test', 'chart-runtime-packaging.test.mjs')], {
      cwd: desktopRoot, stdio: 'inherit', env: { ...process.env, HARNESS_CHART_ADDON: result.paths.addon },
    });
  }
}
