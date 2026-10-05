# 微信 ↔ Slack 桥

纯 TypeScript/Node 传输程序：微信本人私聊的文字与图片进入 Slack，由用户显式配置的官方 Slack 事件自动化唤醒现有个人 dot；dot 在 Slack 的指定线程回复，再回到原微信消息上下文。桥不调用模型，也不创建另一个代理。

**当前为待真实账号验收的 MVP。离线 HTTP 集成测试通过不等于真实微信已接通。** 没有真实令牌、扫码登录或生产部署记录。跨轮连续对话、平台频率及重复回复保护仍需用户醒来后验证。

## 快速开始

需要 Node ≥22.13（推荐 24）、npm，以及由用户授权的 Slack 应用和微信账号。开发与 CI 不需要这些凭据。

```bash
npm ci --ignore-scripts
npm run check
cp config.example.json config.local.json
mkdir -m 700 secrets state
```

修改 `config.local.json` 的虚构身份。通过安全编辑器创建 `secrets/slack.json`，内容字段为 `slackBotToken`、`slackAppToken`，不要把真实值粘进聊天、命令行、README 或 GitHub。设置文件权限 `chmod 600 secrets/slack.json`。然后在用户自己的部署主机交互终端执行：

```bash
npm run build
npm run login
npm start
```

扫码只绑定扫码确认的本人私聊。令牌保存后不需每次输入；过期或撤销后才需重新授权。此处“部署主机”可以是用户选择的云服务器，本项目开发不依赖用户电脑在线。

必须先完成 [Slack 权限与 dot 自动化](docs/Slack配置.md)，否则仅向 Slack 发消息不会自动唤醒 dot。

## 文档

- [架构与投递策略](docs/架构.md)
- [隐私、安全与配置字段](docs/隐私安全.md)
- [云开发、部署与 Docker](docs/部署.md)
- [故障排查及一次性验收](docs/故障排查.md)
- [上游源码、许可和修改](third_party/来源.md)

支持 PNG、JPEG、GIF、WebP 原始文件字节转发；不转码。不支持语音、视频及普通附件。普通回程附件会收到中文说明。每个微信消息创建独立根线程，不会猜测“最近一次”的会话。
