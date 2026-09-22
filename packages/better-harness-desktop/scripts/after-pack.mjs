import { cp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNsxpc, installEsbuildXpc, esbuildServiceId, installAcpXpc, installEvidenceXpc, installDiffXpc, installArchXpc, installPtyXpc, serviceId, acpServiceId, evidenceServiceId, diffServiceId, archServiceId, ptyServiceId } from './nsxpc-bundle.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const native = join(root, 'dist', 'native');
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await installNsxpc(app, native);
  await installEsbuildXpc(app, native);
  // macOS ACP runs through its own launchd NSXPC service: the `harness-acp-xpc`
  // service and the `harness-acp-host` driver it spawns live in the .xpc bundle;
  // the `harness-acp-client` bridge lands in Contents/MacOS next to harness-oxc-client.
  await installAcpXpc(app, native);
  await installEvidenceXpc(app, native);
  // The structural-diff service is the heaviest native call, so its driver only
  // ships inside the .xpc bundle and Studio's bridge goes in Contents/MacOS,
  // exactly like the OXC, ACP and Evidence bridges above.
  await installDiffXpc(app, native);
  // The architecture-impact service ships on both packaging chains, exactly
  // like the four above: a service wired into only one builds locally and is
  // missing from the packaged app.
  await installArchXpc(app, native);
  // The pty terminal service ships on both packaging chains too, same shape as
  // Arch: driver inside the .xpc bundle, bridge in Contents/MacOS.
  await installPtyXpc(app, native);
  // Also keep the plain driver in Resources/native so Windows/Linux and macOS
  // share one packaged-path rule; macOS itself now reaches it through the bundle.
  const nativeResources = join(app, 'Contents', 'Resources', 'native');
  await mkdir(nativeResources, { recursive: true });
  await cp(join(native, 'harness-acp-host'), join(nativeResources, 'harness-acp-host'));
  await cp(join(native, 'harness-evidence-host'), join(nativeResources, 'harness-evidence-host'));
  // Development signatures only. Release identity/notarization is separate. The
  // ACP .xpc holds two mach-O files, so its nested driver is signed on its own
  // before the bundle is sealed.
  for (const target of [
    join(app, 'Contents', 'XPCServices', `${esbuildServiceId}.xpc`),
    join(app, 'Contents', 'MacOS', 'harness-esbuild-client'),
    join(app, 'Contents', 'XPCServices', `${serviceId}.xpc`),
    join(app, 'Contents', 'MacOS', 'harness-oxc-client'),
    join(app, 'Contents', 'XPCServices', `${acpServiceId}.xpc`, 'Contents', 'MacOS', 'harness-acp-host'),
    join(app, 'Contents', 'XPCServices', `${acpServiceId}.xpc`),
    join(app, 'Contents', 'MacOS', 'harness-acp-client'),
    join(app, 'Contents', 'XPCServices', `${evidenceServiceId}.xpc`, 'Contents', 'MacOS', 'harness-evidence-host'),
    join(app, 'Contents', 'XPCServices', `${evidenceServiceId}.xpc`),
    join(app, 'Contents', 'MacOS', 'harness-evidence-client'),
    join(app, 'Contents', 'XPCServices', `${diffServiceId}.xpc`, 'Contents', 'MacOS', 'harness-diff-host'),
    join(app, 'Contents', 'XPCServices', `${diffServiceId}.xpc`),
    join(app, 'Contents', 'MacOS', 'harness-diff-client'),
    join(app, 'Contents', 'XPCServices', `${archServiceId}.xpc`, 'Contents', 'MacOS', 'harness-arch-host'),
    join(app, 'Contents', 'XPCServices', `${archServiceId}.xpc`),
    join(app, 'Contents', 'MacOS', 'harness-arch-client'),
    join(app, 'Contents', 'XPCServices', `${ptyServiceId}.xpc`, 'Contents', 'MacOS', 'harness-pty-host'),
    join(app, 'Contents', 'XPCServices', `${ptyServiceId}.xpc`),
    join(app, 'Contents', 'MacOS', 'harness-pty-client'),
    join(nativeResources, 'harness-acp-host'),
    join(nativeResources, 'harness-evidence-host'),
  ]) {
    execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'inherit' });
  }
}
