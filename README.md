# lark-claude-bot

在你的飞书里 @ 一下就用的 **AI 开发助手**：飞书自建应用 + 官方 lark-cli + Claude Code 无头模式，在一台个人电脑上即可跑起，不需要公网服务器。

## 架构一览

```
┌─────────┐   长连接(websocket)   ┌──────────────┐
│  飞书    │ ◄──────────────────► │   lark-cli    │  ← 飞书官方 CLI，事件监听与 API 调用
│ (自建应用)│                      └──────┬───────┘
└─────────┘                             │ 消息事件 (JSON)
                                        ▼
                                   ┌─────────┐
                                   │  bot.js  │  ← 调度器 + 安全护栏（鉴权/提示词/收发/重试）
                                   └────┬────┘
                                        │ spawn 子进程
                                        ▼
                              ┌──────────────────┐
                              │  claude -p (CLI)  │  ← Claude Code 无头模式，真正的"大脑"
                              │  + 可选 MCP 工具  │     读代码、跑命令、操作网页
                              └──────────────────┘
```

更详细的工作原理见 [docs/工作机制说明.md](docs/工作机制说明.md)。

## 功能特性

- **流式进度可见**：内层 claude 的工具调用实时编辑到回复消息上（节流刷新），完成后原地替换为完整 Markdown 结果
- **会话续聊**：按聊天自动维护 session，隔几天 @ 它还记得上次聊到哪
- **两级信任**：私聊只回主人；受信任群里群友默认只读，写操作（改文件、跑命令）只有主人能触发；非受信任群全员只读；非主人会话自动剥离 MCP 配置并收紧工具白名单
- **防注入**：用户消息里的"忽略之前指令"一律按普通文本处理
- **可靠性**：消息接收 WAL + 投递失败待重试队列，重启自动补发；崩溃堆栈独立落盘；watchdog 看门狗自动拉起
- **记忆**：跨会话记忆按聊天持久化；可接入多 AI 工具共用的共享记忆库
- **后台任务**：耗时操作（构建、批处理）进后台队列，完成后再推送结果
- **需求流水线**（可选）：按会话持久化需求状态机，多阶段开发流程重启可恢复
- **桌面通知**（可选）：任务完成写入通知文件，可对接桌面宠物等提醒工具

## 最快接入：让 AI 帮你部署

不想逐行照手册？把下面这段 prompt **原样**发给你常用的 AI 编码助手（Claude Code / Trae / Kimi / Cursor 均可），它会照着本仓库自动完成部署，只有建飞书应用和登录确认两步需要你自己操作：

```text
我要部署一个飞书 AI 机器人，引擎是 Claude Code CLI，仓库地址：
https://github.com/gaoqiongxie/lark-claude-bot

请先通读仓库里的 README.md 和 docs/工作机制说明.md，然后按下面的分工帮我部署：

【你（AI）自动完成】
1. git clone 该仓库到本地
2. 检查环境：Node.js ≥ 18；npm i -g @larksuite/cli @anthropic-ai/claude-code
3. 复制 .env.example 为 .env，按我的环境填写（我不知道的项先留空并问我）
4. 每次启动前先 node --check bot.js 做语法校验

【必须我本人操作，你给我逐步指令即可，不要编造凭证】
5. 飞书开放平台建企业自建应用：拿 App ID/Secret、订阅 im.message.receive_v1 事件、
   启用长连接(websocket)接收方式、开通 im:message 等权限、发布版本、把机器人拉进群
6. 把 App ID/Secret 登记成 lark-cli profile：lark-cli config init --new --name claude
   --app-id <id> --app-secret-stdin（密钥从我这里用安全方式输入，不要让我贴进对话）
7. 确认 Claude 已登录可用（claude 命令能正常响应）

【联调验证（启动 node bot.js 后）】
8. 我先给机器人发条私聊消息，你从 bot.log 里找到我的 sender open_id，填回 .env 的
   BOT_OWNER_OPEN_ID 并重启
9. 验证清单：bot.log 出现长连接建立成功 → 私聊有回复 → 受信任群 @ 机器人有回复 →
   群友（非主人）@ 它时自动剥离 MCP 并以只读白名单运行

【红线】
10. .env / mcp-servers.json 含凭证，绝不提交 git、绝不完整打印到对话
11. 不执行 git push --force / git reset --hard；本仓库不需要推送到任何远程
12. 部署完成后帮我配 watchdog.vbs 开机自启（Windows：快捷方式指向
    wscript <目录>\watchdog.vbs，放进 shell:startup）
```

> 想要 Codex 引擎版？把仓库地址换成 `https://github.com/gaoqiongxie/lark-codex-bot`，第 2 步依赖换成 `@openai/codex`，第 7 步换成 `codex login` 登录授权即可，其余完全一样。

## 快速开始

### 1. 创建飞书自建应用

1. 在[飞书开放平台](https://open.feishu.cn)创建企业自建应用，拿到 **App ID + App Secret**
2. 订阅事件 `im.message.receive_v1`（接收消息），启用长连接（websocket）接收方式
3. 按需开通权限：消息读写、表情回应、群信息等（im:message、im:message.reactions 等 scope）
4. 发布应用版本，把机器人拉进目标群

### 2. 安装依赖

```bash
# Node.js 18+；Claude Code CLI；飞书官方 CLI
npm i -g @anthropic-ai/claude-code @larksuite/cli
```

### 3. 登记 lark-cli profile

```bash
lark-cli config init --new --name claude --app-id <你的AppID> --app-secret-stdin
```

（可选）`lark-cli auth login --profile claude` 扫码授权后，机器人还能以你个人身份读你可见的文档。

### 4. 配置机器人

```bash
git clone https://github.com/<你>/lark-claude-bot.git
cd lark-claude-bot
cp .env.example .env   # Windows: copy .env.example .env
```

编辑 `.env`，至少填两项：

| 变量 | 说明 |
|------|------|
| `LARK_PROFILE` | 上一步的 profile 名 |
| `BOT_OWNER_OPEN_ID` | 你的 open_id（给机器人发条消息，看日志里 sender 的 open_id） |

可选：`BOT_CODE_ROOT`（代码根目录，开发助手能力）、`BOT_TRUSTED_CHATS`（受信任群 chat_id 逗号分隔）、`BOT_SKILLS_DIR` / `BOT_MEMORY_BANK`（技能库 / 共享记忆库）、`BUDDY_NOTIFY_FILE`（桌面通知文件）。

### 5. 启动

```bash
node bot.js
```

Windows 开机自启：创建一个快捷方式指向 `wscript <本目录>\watchdog.vbs`，放进 shell:startup。watchdog 每 30 秒检查 bot 进程，死了自动拉起。

### 6.（可选）挂载 MCP 工具

复制 `mcp-servers.example.json` 为 `mcp-servers.json`，填入你的 MCP 服务（如 Playwright 浏览器自动化）。凭证用环境变量注入。**只有主人会话才会挂载 MCP**，且该文件已在 `.gitignore` 中，不会被提交。

### 7.（可选）网络救急代理

办公网若封锁飞书 API 网段，可用 `python feishu-proxy.py` 起一个本地 CONNECT 代理，并把地址填进 `.env` 的 `FEISHU_RESCUE_PROXY`。正常网络无需理会。

## 目录说明

```
bot.js                 核心：约 1400 行单文件，监听/鉴权/提示词/收发/重试/流水线
bg-runner.js           后台任务执行器（bot.js 派生子进程）
feishu-proxy.py        网络救急代理（可选）
watchdog.vbs           Windows 看门狗：进程死亡自动拉起（开机自启用）
docs/工作机制说明.md    面向同事的架构与原理分享
.env.example           全部配置项说明
mcp-servers.example.json  MCP 配置示例
```

运行时自动创建（均已 gitignore）：`bot.log`、`bot-memory/`、`pipeline/`、`bg-tasks/`、`ops-logs/`、`stream-tee/`、`tmp/`、`work/`、`outbox/`、各类 WAL 文件。

## 相关项目

- [desktop-work-buddy](https://github.com/gaoqiongxie/desktop-work-buddy)：桌面宠物，可通过 `BUDDY_NOTIFY_FILE` 接收本机器人的完成通知
- [ai-dev-workflow](https://github.com/gaoqiongxie/ai-dev-workflow)：可接入 `BOT_SKILLS_DIR` 的开源 AI 协作开发工作流 skill 集

## 安全说明

- App Secret 存于 lark-cli 本地密钥库，不进入本仓库任何文件
- `.env`、`mcp-servers.json`（含凭证）均在 `.gitignore` 中
- 开源版已剥离所有个人/内部信息：内部需求系统、内部平台、绝对路径等一律泛化或改为环境变量注入
- 一个飞书应用的事件通道同时只能有一条长连接，同一应用不能两台电脑同时监听

## 许可

MIT（或按你的需要自行选择）。代码在个人真实使用中持续演进，欢迎提 Issue 交流场景。
