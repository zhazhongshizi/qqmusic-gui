# 隐私与公开内容

初次公开仓库为 1.0.0 当前源码快照，未携带维护者的本地 Git 历史、HANDOFF、内部验收、个人参考截图或运行数据。内容为源码、配置、锁文件、许可证、虚构测试样例、公开文档及介绍图。

截图使用实际前端与虚构数据，阻断外部请求，不加载 Credential Manager、真实 SQLite 或 WebView 用户存储。

运行时凭据保存在 Windows Credential Manager（`QQMusicGUI/Auth/v1`）；队列、历史和资料保存在用户应用数据目录的 SQLite，部分 UI 数据在 WebView 存储。设备身份同样保存在用户数据目录，缓存图片及可选日志位于应用旁。没有自动遥测上传；认证和播放仍访问 QQ 音乐服务。

提交或反馈前：

- 不上传凭据导出、Cookie、二维码、设备 JSON、连接码或限时媒体 URL。
- 不上传 `state.sqlite3`、`smart-shuffle.sqlite3` 及 WAL／SHM、实际统计、数据库备份或数据导出。
- 不上传 `cover-cache`、`logs`、`output`、用户数据或 WebView 配置目录。
- 截图优先用虚构数据；真实环境先遮盖账号、个人歌单、路径与统计。

`.gitignore` 是辅助，提交前仍需检查文件与 diff。安全问题使用私密渠道。
