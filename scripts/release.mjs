/**
 * 构建 Windows 安装包并发布到 GitHub Releases。
 *
 * 为什么输出目录必须放在系统临时目录：
 * 本项目位于 Documents 工作区，工作区的文件监控会持有刚写入文件的句柄。
 * Windows 不允许给「含有已打开文件的目录」改名，而 electron-builder 在收尾阶段
 * 需要把 win-unpacked.tmp 改名为 win-unpacked；它会先撞上
 * resources/default_app.asar 的 EBUSY（共享冲突），在目录这一层就表现为
 * EPERM: operation not permitted, rename 'win-unpacked.tmp' -> 'win-unpacked'。
 * 实测这个失败是恒定的，不是杀毒软件偶发扫描。把输出挪出工作区即可绕过。
 *
 * 因此这里用 os.tmpdir() 覆盖 directories.output，而不是写死 release/。
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build, Platform } = require('electron-builder');

const outputDir = path.join(os.tmpdir(), 'orbit-build');

console.log(`[release] 输出目录（工作区外）：${outputDir}`);

await build({
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable']),
  config: {
    directories: { output: outputDir },
  },
  publish: 'always',
});

console.log(`[release] 完成，产物位于 ${outputDir}`);
