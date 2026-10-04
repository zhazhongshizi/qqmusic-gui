# Third-Party Notices

本文件记录 QQ Music GUI 的直接第三方依赖。发行前会根据最终锁文件生成并复核完整清单；未进入发行物的开发工具会与运行时依赖分开标注。

QQ 与 QQ 音乐相关名称、服务和标识归其权利人所有。本项目为非官方社区客户端，不代表腾讯或 QQ 音乐。

## QQMusicApi

- Project: `L-1124/QQMusicApi`
- Source: https://github.com/L-1124/QQMusicApi
- Package: `qqmusic-api-python`
- Baseline version: `0.6.9`
- License: GNU General Public License v3.0 or later
- Use: Python provider 中的 QQ 音乐认证、目录、歌单、歌词和标准 GetVkey 适配。

本项目不复制 `Davied-H/ncm-cli` 源码。该仓库仅作为职责分层和用户流程参考；设计审阅时其根目录未发现许可证文件，因此任何源码复用都不在本项目范围内。

## LBEILC / RhineLabUI

- Source: https://github.com/LBEILC/RhineLabUI
- Vendored code and notice: [vendor/rhine/README.md](vendor/rhine/README.md), [MIT License](vendor/rhine/LICENSE).
- Use: Rhine archive scene, opening sequence and original cassette / assembly models, with local adaptations.
- Copyright (c) 2026 LBEILC. Preserve the upstream MIT license when distributing these portions.
- The upstream's current resource permission covers the author's own original models and screenshots / redistribution. Third-party Arknights names, marks and original-work elements remain excluded; consult the upstream resource-rights statement.

## AMD FidelityFX FSR 1

- Source: https://github.com/GPUOpen-Effects/FidelityFX-FSR/tree/master/ffx-fsr
- License: MIT
- Use: Rhine 3D spatial upscaling trial, adapted from the 32-bit EASU and RCAS algorithms in `ffx_fsr1.h`.
- Adaptations: WebGL2 texelFetch taps instead of texture gathers, floating-point constants, finite reciprocal helpers, and fixed RCAS strength with noise attenuation.

Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Runtime framework baseline

当前安全本地边界的直接 Rust 依赖包括：

- `rusqlite 0.40.1`（MIT），使用 `bundled` SQLite；
- `zeroize 1.8.2`（Apache-2.0 OR MIT），用于 secret 缓冲区释放清零；
- `uuid 1.23.4`（Apache-2.0 OR MIT），用于关联编号、设备身份和唯一测试目标。

最终发行物还将包含 Tauri、React、Rust crates、Python packages 和相关传递依赖。它们的版本、许可证文本、来源和是否进入运行时会从 `pnpm-lock.yaml`、`Cargo.lock` 与 Python 锁文件生成，并在发行候选阶段固化；本文件不会用未锁定的预估清单冒充最终声明。
