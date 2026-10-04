# 贡献指南

先阅读 [README](README.md) 和 [架构说明](docs/architecture.md)。Issue 请写明应用／Windows 版本、复现步骤、预期与实际行为，附图需遮盖账号、二维码、连接码、私人歌单与统计。安全问题见 [SECURITY](SECURITY.md)。

1. Fork 仓库，从 `main` 创建功能分支。
2. 一次解决一个清晰问题，说明行为变化与验证方式。
3. 按影响运行类型检查、相关测试和构建，注明未完成的桌面或服务验收。
4. 提交 Pull Request，保留现有协议、共享播放会话与版权声明。

莱茵修改入口是 `vendor/rhine/src/`，生成目录 `src/features/rhine/vendor/` 不提交。测试使用虚构账号、曲目与凭据占位符；不提交 Cookie、二维码、SQLite、设备 JSON、个人历史、日志、缓存、音频、`output/` 或本机构建产物。 `.gitignore` 不能代替检查实际 diff。

引入依赖或素材时记录来源、许可与署名。第三方服务权益和原作素材授权不由本项目代替。
