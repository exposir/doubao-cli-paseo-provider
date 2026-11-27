# doubao-cli-paseo-provider

把字节官方的 [豆包 CLI](https://www.npmjs.com/package/@bytedance/doubao-cli)（`doubao`）接入
[Paseo](https://paseo.sh) 的 Provider 插件。

## 为什么不用 ACP

`doubao` 虽然有 ACP 模式，但无头场景真正好用的是它的 `--output-format stream-json`：

- 文本增量
- 最终的 assistant 消息
- 原生 session id
- 终态 result

这些都在同一条流里。插件直接消费这条流，所以每轮只起一个进程，没有 ACP 握手和反复探测，
会话续接也更准确。

## 特性

- **流式输出**：`stream_event` 的增量会合并成一条持续增长的 assistant 消息
- **原生续聊**：从 `system` 事件拿到 `session_id` 并持久化，下一轮用 `--resume` 接上
- **动态目录**：模型、每个模型的 effort 档位、默认档位全部来自
  `doubao model list --output-format json`，不硬编码模型名，也不依赖中英文文案
- **会话发现**：`doubao --list --output-format json` 映射为 Paseo 的会话列表
- **探测有超时**：CLI 卡死不会拖住 Paseo 的 provider 目录
- **没有全局队列**：一个长任务不会阻塞目录读取、配置修改和其它会话

## 前置要求

| 项 | 版本 |
| --- | --- |
| Paseo | >= 0.15.0 |
| Node | >= 22 |
| 豆包 CLI | 已安装并登录（`doubao auth status` 退出码为 0） |

## 安装

```bash
git clone https://github.com/Angboo/doubao-cli-paseo-provider.git
cd doubao-cli-paseo-provider
npm install
paseo plugin install .
```

验证：

```bash
paseo plugin ls
paseo run --provider doubao "只回复：PONG"
```

## 使用

```bash
paseo run --provider doubao "解释一下这个仓库的架构"
paseo run --provider doubao --model person-deepseek-v4-1-flash-261017 --thinking max "重构数据层"
paseo send <agent-id> "给这次改动补单元测试"
```

模型 id 和 effort 档位以你账号下 CLI 返回的为准。

## 开发与测试

完整的测试分层、环境变量和排错表见 [docs/TESTING.md](docs/TESTING.md)。

```bash
npm install
npm run typecheck
npm test          # 单元测试，不需要 CLI
npm run test:live # 单元测试 + 真实 CLI（会发一条很小的提示词）
npm run e2e       # 起一个临时 Paseo daemon（随机空闲端口），装插件、跑一轮、
                  # 再追问一轮验证续聊
npm run e2e:draw  # 完整绘画流程：生成图片、不重画只描述、再画夜景版本
```

| 测试文件 | 覆盖内容 |
| --- | --- |
| `stream.test.ts` | NDJSON 拆包、UTF-8 跨包、重复 session id、增量累积、assistant/result、错误终态 |
| `catalog.test.ts` | 模型列表映射、脏数据、缓存 TTL、并发合并探测 |
| `sessions.test.ts` | 会话列表映射、持久化 id |
| `args.test.ts` | 新会话与续聊的参数顺序 |
| `prompt.test.ts` | 文本、图片、文件、PR、Issue、Review 格式化 |
| `errors.test.ts` | stderr 清理与错误码 |
| `session.test.ts` | 假 CLI 驱动的状态机：续聊、中断、失败、运行中关闭 |
| `provider.test.ts` | 注册、能力协商、请求分发、缓存键 |
| `cli.test.ts` | 协议行提取（跳过日志与坏行） |
| `live.test.ts` | 真实 `model list` 与 `--list` |
| `live-provider.test.ts` | 完整链路：open → prompt → completed → 持久化 |
| `scripts/e2e.sh` | 临时 Paseo daemon（随机端口）：安装、运行、续聊 |
| `scripts/e2e-drawing.sh` | 三轮绘画流程：生成、描述、重绘；校验 PNG 魔数、尺寸、体积，并确认第二张图不同 |

## 已知限制

- 时间线目前只有文本，工具调用还没有映射成 Paseo 的工具卡片
- 附件会转成可读的上下文块，不会把二进制内容传给 CLI
- `--permission-mode` 会透传，但无头的 `-p` 模式无法交互审批，不要把它当成硬性审批闸门
- 中断先发 `SIGINT`，宽限期后 `SIGKILL`

## 许可证

MIT
