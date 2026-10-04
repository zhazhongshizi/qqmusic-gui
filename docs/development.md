# 开发与发行

环境为 Windows x64、Node.js 24、pnpm 11、Rust stable 1.88+ MSVC、Visual Studio Build Tools、Windows SDK、WebView2 与 Python 3.13 x64。

```powershell
pnpm install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-provider.ps1 -PythonExe "C:\Path\To\Python313\python.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-provider.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/debug-review.ps1 -Action Run
```

Provider `.venv`、`build`、`dist`、staged resources 为本地生成物。Python 修改后要运行冻结桌面版或发行时重新冻结；纯 Python 测试不需冻结。

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 编译 Rhine 并预览前端，真实桌面能力需 Tauri |
| `pnpm typecheck`、`pnpm test:run` | 类型与前端测试 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Rust 测试 |
| `provider/.venv/Scripts/python.exe -m pytest provider/tests` | Provider 测试 |
| `scripts/build-frontend.ps1` | 主／Remote 生产前端 |
| `scripts/verify-fast.ps1 -Scope Frontend` | 定向验证，可选 Frontend／Rust／Provider／All |
| `scripts/build-portable.ps1` | 默认 Windows x64 portable |

PowerShell 脚本使用 `powershell -NoProfile -ExecutionPolicy Bypass -File ...`。Debug 路径为 `src-tauri/target/debug/qqmusic-gui.exe`，避免覆盖运行或审阅实例。验证按影响选择，编译与浏览器不能替代 WebView2、账号和真实播放验收。

Portable 默认冻结／stage Provider、构建主和 Remote 前端、编译 Release，在 `output/releases/` 创建唯一目录与 ZIP。标准脚本包含 Provider 清单、live 模式和目标检查，不读取个人账号或听歌数据库。NSIS 安装包需显式用 `scripts/build-release.ps1 -Installer`。

版本同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 应用条目与 `src-tauri/tauri.conf.json`。发布包只带 GUI、对应 Provider、README、LICENSE 与第三方声明；不要打包运行过的目录，以免带入日志和个人数据。Release 需提供对应源码并说明实际验证范围。
