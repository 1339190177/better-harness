import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNsxpc, installAcpXpc, installBoxXpc, installEvidenceXpc, installDiffXpc, installArchXpc } from './nsxpc-bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const test = process.argv.includes('--test');

/** Build or test one Rust capability service, sharing the dist target cache. */
function cargo(crate) {
  execFileSync('cargo', ['+1.96.0', test ? 'test' : 'build', '--release', '--locked',
    '--manifest-path', join(root, 'rust', crate, 'Cargo.toml'),
    '--target-dir', join(root, 'dist', 'rust')], { stdio: 'inherit' });
}

/** Stage a built executable outside dist/rust so packaging never ships the cache. */
async function stage(name) {
  const binary = process.platform === 'win32' ? `${name}.exe` : name;
  await mkdir(join(root, 'dist', 'native'), { recursive: true });
  await cp(join(root, 'dist', 'rust', 'release', binary), join(root, 'dist', 'native', binary));
}

/** BoxLite compiles from source and needs protoc; no other service does. */
function hasProtoc() {
  try {
    execFileSync('protoc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

cargo('oxc-service');
cargo('acp-host');
cargo('evidence-host');
// Building the diff service also builds the vendored `difftastic-core` engine
// it links; the engine has no build step of its own.
cargo('diff-service');
cargo('arch-service');
// The microVM shim is optional. Without protoc the rest of the build still
// succeeds, Studio is given no `boxExecExecutable`, and the Debugger hides the
// microVM placement rather than offering one it cannot honour.
const box = process.platform !== 'win32' && hasProtoc();
if (box) cargo('box-service');
else console.warn('[rust] skipping box-service: needs protoc >= 3.12 (brew install protobuf) on macOS or Linux');
if (!test) {
  await stage('harness-oxc-service');
  // Windows/Linux spawn the ACP driver directly; macOS reaches it through the
  // NSXPC bundle below. Staging it also keeps one path rule across platforms.
  await stage('harness-acp-host');
  await stage('harness-evidence-host');
  await stage('harness-diff-host');
  await stage('harness-arch-host');
  // Studio spawns the shim directly in an Agent's place, so it is a plain
  // staged executable. The driver beside it is the off-macOS fallback; on macOS
  // the shim prefers the bundled bridge staged below, which reaches the one
  // shared driver and so allows concurrent boxed runs.
  if (box) {
    await stage('harness-box-exec');
    await stage('harness-box-host');
  }
  // The engine is MIT-licensed third-party code vendored into this repository,
  // so its notice is staged beside the binaries every installer copies from,
  // rather than inside the cargo cache that packaging ignores.
  await writeFile(
    join(root, 'dist', 'native', 'harness-diff-service.NOTICES.txt'),
    (await Promise.all([
      readFile(join(root, 'rust', 'difftastic-core', 'NOTICE.md'), 'utf8'),
      readFile(join(root, 'rust', 'difftastic-core', 'LICENSE'), 'utf8'),
    ])).join('\n'),
  );
}

if (!test && process.platform === 'darwin') {
  const binaries = join(root, 'dist', 'rust', 'release');
  const native = join(root, 'dist', 'native');
  for (const binary of [
    'harness-oxc-client', 'harness-oxc-xpc',
    'harness-acp-client', 'harness-acp-xpc',
    'harness-evidence-client', 'harness-evidence-xpc',
    'harness-diff-client', 'harness-diff-xpc',
    'harness-arch-client', 'harness-arch-xpc',
  ]) {
    await cp(join(binaries, binary), join(native, binary));
  }
  const oxcApp = join(root, 'dist', 'native', 'Harness OXC.app');
  await installNsxpc(oxcApp, binaries, { development: true });
  execFileSync('codesign', ['--force', '--sign', '-', '--deep', oxcApp], { stdio: 'inherit' });
  const acpApp = join(root, 'dist', 'native', 'Harness ACP.app');
  await installAcpXpc(acpApp, binaries, { development: true });
  execFileSync('codesign', ['--force', '--sign', '-', '--deep', acpApp], { stdio: 'inherit' });
  const evidenceApp = join(root, 'dist', 'native', 'Harness Evidence.app');
  await installEvidenceXpc(evidenceApp, binaries, { development: true });
  execFileSync('codesign', ['--force', '--sign', '-', '--deep', evidenceApp], { stdio: 'inherit' });
  const diffApp = join(root, 'dist', 'native', 'Harness Diff.app');
  // The diff installer reads the engine's third-party notice from the staging
  // directory, beside the driver it ships inside the service bundle.
  await installDiffXpc(diffApp, native, { development: true });
  execFileSync('codesign', ['--force', '--sign', '-', '--deep', diffApp], { stdio: 'inherit' });
  const archApp = join(root, 'dist', 'native', 'Harness Arch.app');
  // The arch service bundles no vendored engine, so unlike Diff it installs no
  // third-party notice.
  await installArchXpc(archApp, native, { development: true });
  execFileSync('codesign', ['--force', '--sign', '-', '--deep', archApp], { stdio: 'inherit' });
  if (box) {
    for (const binary of ['harness-box-client', 'harness-box-xpc']) {
      await cp(join(binaries, binary), join(root, 'dist', 'native', binary));
    }
    const boxApp = join(root, 'dist', 'native', 'Harness Box.app');
    await installBoxXpc(boxApp, binaries, { development: true });
    // No entitlements file: BoxLite ad-hoc signs its own shim with the
    // hypervisor one, so neither this service nor its driver needs one.
    execFileSync('codesign', ['--force', '--sign', '-', '--deep', boxApp], { stdio: 'inherit' });
  }
}
