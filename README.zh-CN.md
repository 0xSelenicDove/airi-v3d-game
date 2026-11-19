# AI World（airi-v3d-game）

[English](README.md) | **简体中文**

**[在线演示](https://0xselenicdove.github.io/airi-v3d-game/)**（使用模拟大脑和两个公开的示例形象；想要完整体验，请在本地加入自己的 `.vrm` 模型和大模型）

一个完全由 AI 驱动的小型 3D 世界。可以把它理解成「VRChat，但里面的居民是 AI」：每个 AI 都有自己的 VRM 形象，住在同一个房间里，有自己的生活规律（睡觉、读书、用电脑），会记住发生过的事，也会和其他 AI 聊天。

使用 TypeScript、[three.js](https://threejs.org/) 和 [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) 构建，直接在浏览器里运行，没有后端。

> 当前状态：可运行的原型。默认使用内置的规则型「模拟大脑」驱动 AI。你可以接入任何兼容 OpenAI 接口的大模型（自己的模型、Ollama、LM Studio、vLLM 等），并且已经用一个真实的托管模型试过（通过 302.ai 调用 Gemini 2.5 Flash，见下文）。

## 功能

- **自主的 AI 居民**：有能量、娱乐、知识三种需求来驱动行为，有人设，还有昼夜时钟。
- **基于「可供性」的世界**：物体会声明自己能做什么（`床 → 睡觉`、`电脑桌 → 用电脑`、`书架 → 读书`）。AI 只选择高层动作，走路和动画由世界处理。
- **可替换的大脑**：模拟的效用型大脑，或兼容 OpenAI 接口的 LLM 大脑（带 JSON 动作解析、超时、错误反馈和自动回退）。
- **记忆系统**（参考《Generative Agents》）：记忆流、按时效 + 重要性 + 相关性检索、定期反思生成「感悟」，并通过 `localStorage` 在刷新后保留。
- **多 AI 共存**：家具同一时间只能一个人使用（一张床、一张桌子一个人），附近的 AI 能真正听到说话内容，每个 AI 有各自的人设和作息。
- **寻路**：在家具和墙壁之间用网格 A* 绕行，并带调试可视化。
- **行为规则**（[`src/skills/RULES.md`](src/skills/RULES.md)），由技能执行并由测试检查：物体之间不能穿模；上床睡觉前要脱鞋；先在床边坐下再躺下；开门要先握住门把手，慢慢打开，出门后转身关门；碰到障碍过不去时，停下来想想要不要换条路，而不是硬挤过去。
- **偶遇**：AI 以从容的速度走路，彼此保持距离，迎面相遇时各自靠右让行。两个 AI 碰面时，会随机停下来闲聊、挥手打招呼，或者直接走过。
- **VRM 形象**与程序化动画：走路、坐着打字、拿书阅读、睡觉、呼吸、眨眼、说话手势、看向附近的 AI。
- **表演**：大模型（或模拟大脑）可以让身体做动作，比如挥手、举手、抬腿、点头、鞠躬、拍手、指向、伸懒腰、欢呼、跳起，也能设置表情（开心、难过、生气、惊讶、放松、害羞）。适用于任何 VRM。
- **世界物理**（[Rapier](https://rapier.rs/)）：家具、墙、栅栏和树都是实体。只有身体有足够空间时动作才会执行，否则会告诉模型是什么挡住了。跳跃遵循重力，人走过时会把沙滩球推开，头发和衣服会贴着附近的靠背、桌子和墙。
- **场景内 UI**：头顶的名字标签、对话气泡和思考气泡。
- **相机**：旋转 / 平移 / 缩放，以及跟随模式。手动移动相机会结束跟随。相机始终保持在离地面约 27° 以上的角度。
- **语音**：AI 说话时用浏览器自带的语音合成朗读（每个 AI 音色不同，离相机越远越轻）。需要先点一下页面或按任意键才会发声。

## 快速开始

需要 Node.js 18 及以上。

```bash
npm install
npm run dev
```

然后打开 http://localhost:5173。

### 添加角色模型

把你自己的模型放到这里（VRM 0.x 和 1.0 都可以）：

```
public/model.vrm    # 第一个 AI（Airi）
public/model2.vrm   # 第二个 AI（Luna）
```

没有模型时，游戏会使用 [`public/models/avatars`](public/models/avatars) 里两个来自 VRM 官方示例的公开形象：Luna 用 **Seed-san model by VirtualCast, Inc.**，Airi 用 pixiv Inc. 的 VRM1_Constraint_Twist_Sample。两者都采用 [VRM Public License 1.0](https://vrm.dev/licenses/1.0/)。模型加载完成前，AI 会显示为彩色胶囊体。你也可以把 `.vrm` 文件直接拖到页面上：拖到屏幕左半边会替换第一个 AI 的模型，右半边则替换第二个。

加载模型时，超过 1024 像素的贴图会缩小到 1024 像素（[`src/prepare.ts`](src/prepare.ts) 里的 `MAX_TEXTURE`）。VRoid 导出的模型常带 4096 像素的贴图，每个角色约占 1.5 GB 显存，而在这个镜头距离下看起来没有区别。着色器编译和贴图上传会在模型出现之前完成，所以模型出现时游戏不会卡住。

## 操作

| 输入 | 作用 |
| --- | --- |
| 拖动 | 旋转相机 |
| 右键拖动 | 平移 |
| 滚轮 | 缩放 |
| `F` | 切换跟随相机：Airi → Luna → 自由视角。手动移动相机会结束跟随。 |
| `R` | 重置视角 |
| `1` / `2` / `3` | 游戏速度（正常 / 快 / 最快） |
| `G` | 开关寻路调试层（不可走区域和路线） |
| `M` | 开关 AI 的语音 |

在网址后加上 `?reset`（`http://localhost:5173/?reset`）可清空已保存的记忆和时钟。

## 接入真实大模型

1. 把 `.env.example` 复制为 `.env.local`。
2. 填写接口地址和模型名：

   ```bash
   # Ollama:    http://localhost:11434/v1/chat/completions
   # LM Studio: http://localhost:1234/v1/chat/completions
   VITE_LLM_URL=http://localhost:11434/v1/chat/completions
   VITE_LLM_MODEL=你的模型名
   # VITE_LLM_KEY=
   ```

3. 重启 `npm run dev`（Vite 只在启动时读取环境变量文件）。

可选：`VITE_LLM_SYSTEM_ROLE=1` 会把指令作为真正的 `system` 消息发送。默认是把指令放在用户消息里，因为有些托管模型（包括下面测试用的 Gemini）这样才能更稳定地遵守 JSON 格式。

启用后界面左上角会显示 `brain: LLM`。如果某次调用失败或返回内容无法解析，AI 会回退到模拟大脑，并在界面上显示警告。

说明：

- 每一轮会要求模型返回一个 JSON 动作，外加一句简短的 `thought`（想法）：
  `{"thought":"...","type":"interact","object":"desk","verb":"use_computer"}`。其他动作有 `say`（说话）、`gesture`（做动作）和 `wait`（等待）。
- 想做动作时，模型可以在 `say` 里加上 `"emotion"` 和 `"gesture"`，或者发送 `{"type":"gesture","gesture":"nod"}`。也可以像 [LumenAct](https://github.com/AaBb-coder/LumenAct) 那样在台词开头加标签：`（微笑）（挥挥右手）早上好！` 或 `(smile)(wave) Morning!`。`挥挥左手`、`把右手举高`、`抬起右腿` 这类中文指令（与 [HAST-SEC](https://github.com/sola1039/HAST-SEC) 相同的说法）会对应到动作。完整列表见 [`src/acting.ts`](src/acting.ts)。
- 提示词里会列出所有合法动作；如果模型回复的格式有偏差（例如 `{"command":"sleep bed2"}`），只要意图明确也能被识别。统计数据可在控制台用 `dbg.brain.stats` 查看（`strict` / `coerced` / `failed`）。
- 如果模型选了不存在的物体或动作，错误信息会在它下一轮的观察里返回给它。
- 所有请求都由浏览器直接发出。如果你的服务器拦截跨域请求，请允许 `http://localhost:5173`（Ollama 需要设置 `OLLAMA_ORIGINS`）。
- 任何 `VITE_` 开头的变量都会暴露在浏览器里，请不要在这里放正式环境的 API 密钥。

## 让 AIRI 进入这个世界（MCP）

[AIRI](https://github.com/moeru-ai/airi) 或任何其他 MCP 客户端，都可以作为 **Airi** 生活在这个世界里，由自己做决定。Luna 仍然是 NPC，用她自己的大脑。

```
AIRI ⇄ MCP（stdio 或 HTTP）⇄ bridge/airi-mcp.mjs ⇄ WebSocket（127.0.0.1:8789）⇄ 游戏页面（?airi）
```

1. 在本仓库运行 `npm install`。
2. 在 AIRI 的 MCP 服务器设置（它的 `mcp.json`）里添加桥接，二选一：
   - stdio：由 AIRI 自己启动桥接。
     ```json
     { "mcpServers": { "airi-v3d-game": { "command": "node", "args": ["<airi-v3d-game 的路径>/bridge/airi-mcp.mjs"] } } }
     ```
   - HTTP：先用 `npm run airi-bridge` 启动桥接，再让 AIRI 连接这个地址。
     ```json
     { "mcpServers": { "airi-v3d-game": { "url": "http://127.0.0.1:8790/mcp" } } }
     ```
3. 在地址后面加上 `?airi` 打开游戏，例如 `http://localhost:5173/?airi`，在线演示也可以加 `?airi`。HUD 会显示 `AIRI: connected, playing Airi`。

AIRI 可以使用这些工具：

| 工具 | 作用 |
| --- | --- |
| `world_status` | 当前时间、Airi 和其他人在做什么、在哪里，以及 `act` 支持的动作和表情 |
| `look` | Airi 看到的情况：需求、可以使用的东西（id 和动词）、附近的人、听到的话、记忆、上一个行动的结果 |
| `act` | 使用物品、说话、做动作或等待。`interrupt: true` 会先结束当前的活动 |
| `wait_for_event` | 上次调用之后发生的事：Airi 做了什么、注意到什么、听到什么；轮到她做决定时有 `turn` 事件，自己的大脑代为决定时有 `autopilot` 事件 |

- AIRI 连接期间，Airi 会等待 AIRI 的下一个行动。AIRI 的模型只在轮到它时才行动，所以如果 60 秒内没有给出行动，就由 Airi 自己的大脑决定这一件事（自动驾驶）。AIRI 会收到 `autopilot` 事件，可以用 `interrupt: true` 改掉。用 `?airi&autopilot=<秒>` 修改时间，`autopilot=0` 关闭。
- AIRI 断开后，Airi 会回到自己的大脑。
- 桥接只监听 127.0.0.1，只接受来自本机和在线演示的游戏页面。可以用 `--origin` 添加其他来源。
- 用 `--ws <端口>`（默认 8789）和 `--http <端口>`（`npm run airi-bridge` 默认 8790）修改端口。改了 WebSocket 端口时，用 `?airi=ws://127.0.0.1:<端口>` 打开游戏。
- 游戏标签页要保持在前台。浏览器会暂停后台标签页，那时游戏无法响应。

## 工作原理

```
World（时钟、物体、占用、说话） ── Agent（需求、状态机、记忆） ── Brain（决策 / 反思）
            │                                        │
            └──────── Avatar（VRM、姿势、气泡） ◄────┘          three.js 场景 + 相机
```

每个 AI 有两个循环。**慢循环**只在 AI 空闲时向大脑要下一个动作；**快循环**（走路、动画、需求衰减）每帧运行，不需要模型参与。这样可以控制大模型的费用和延迟。

| 文件 | 作用 |
| --- | --- |
| [`src/world.ts`](src/world.ts) | 时钟、物体及其可供性（来自 `src/room-layout.json`）、占用、说话广播、寻路网格和 A* |
| [`src/agent.ts`](src/agent.ts) | AI 状态机、需求、观察、动作校验、触发反思、走路和避让 |
| [`src/social.ts`](src/social.ts) | 偶遇：两个 AI 碰面时打招呼、挥手和闲聊 |
| [`src/skills/`](src/skills) | 行为规则和执行它们的技能：上床睡觉、开关门、绕路 |
| [`src/acting.ts`](src/acting.ts) | AI 能表演的动作和表情，以及大模型可以使用的说法和标签 |
| [`src/physics.ts`](src/physics.ts) | Rapier 物理世界：实体场景、AI 的身体、沙滩球，以及动作的空间检测 |
| [`src/brain.ts`](src/brain.ts) | `MockBrain`、`LLMBrain`、JSON 动作解析 |
| [`src/airi.ts`](src/airi.ts) | AIRI 进入世界：由 AIRI 驱动的大脑，以及页面与 MCP 桥接（[`bridge/airi-mcp.mjs`](bridge/airi-mcp.mjs)）的连接 |
| [`src/memory.ts`](src/memory.ts) | 记忆流、评分检索、淘汰、序列化 |
| [`src/avatar.ts`](src/avatar.ts) | VRM 加载、程序化动画、名字标签和气泡 |
| [`src/main.ts`](src/main.ts) | 场景、房间模型、相机、持久化、调试层 |
| [`src/types.ts`](src/types.ts) | 共享类型（动作、观察、人设） |

### 自定义

- **添加人设**：在 `src/main.ts` 的 `personas` 里加一项（名字、描述、颜色、睡眠时段、床），并加上出生位置，再在 `src/world.ts` 里给它一张床。
- **添加物体**：在 `tools/blender/build_room.py` 里摆放家具并写好交互，然后重新运行（见下文）。游戏从 `src/room-layout.json` 读取物体，并显示 `public/models/room.glb`。
- **使用自己的模型**：在 `src/brain.ts` 里实现 `Brain` 接口（`decide`，可选 `reflect`），然后在 `src/main.ts` 里把它交给 AI。

### 房间模型（Blender）

[`tools/blender/build_room.py`](tools/blender/build_room.py) 会在 Blender 里用低多边形的 [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit)（CC0）拼出一个带家具的单间，用到的模型放在 [`assets/kenney-furniture-kit`](assets/kenney-furniture-kit)。房间里有两张床、衣柜、沙发、单人沙发、电视、书桌、书架、厨房（冰箱、水槽、灶台）、餐桌和凳子、洗衣机、窗户和门。游戏启动时会加载它，并隐藏挡在相机和房间之间的墙。

房间很轻量：约 8,600 个三角面、约 130 次绘制调用、没有贴图，GLB 约 500 KB。

```bash
blender -b --factory-startup -P tools/blender/build_room.py -- --repo .
```

它会生成三个文件：

| 文件 | 内容 |
| --- | --- |
| `public/models/room.glb` | 给 three.js 用的房间。每件家具是一个 `FURN_<id>` 节点，交互点是 `IP_<id>_use` 和 `IP_<id>_approach` 节点。 |
| `src/room-layout.json` | 家具占地范围和交互物体（`pos`、`usePos`、`approach`、`affordances`），使用游戏坐标，格式与 `WorldObject` 一致。`src/world.ts` 会导入它。 |
| `assets/room.blend` | 同一个场景，可以在 Blender 里编辑。 |

遇到下面这些情况，脚本会报错并停止：

- 两件家具互相穿插（用真实网格的三角面检测）。
- 坐着、躺着或站着的角色会和家具穿模（按 `src/avatar.ts` 里的姿势）。
- 座椅或床的高度和这些姿势对不上。
- 某个交互点在寻路网格上走不到。

加上 `--render <目录>` 还会输出预览图。

## 已知限制

- 刷新后只保留记忆和世界时钟，位置和需求会重置。
- 记忆检索的「相关性」目前是关键词重合，不是向量嵌入。
- 如果 `public/motions` 里没有动作片段，动画就是程序生成的，比真实动作更僵硬。动作片段只覆盖走路和站立（用 Kimodo 生成，见 [`tools/kimodo`](tools/kimodo/README.md)）。
- 偶遇时的闲聊用的是按情境挑选的固定台词，不是大模型生成的。
- 如果有人堵住了唯一的通道（比如站满了大门），走路的 AI 会等待，最后放弃，不会把人挤开。
- LLM 大脑目前只试过通过 302.ai 调用的 Gemini 2.5 Flash（不思考模式）：每次决策约 2-3 秒，约 100 秒的运行中 11 次回复里 10 次格式完全正确、1 次被识别修正。其他模型可能需要调整提示词。AI 之间的聊天也容易重复。
- 头发和衣服在每个方向上贴着最近的表面（一个平面），所以弯曲得很厉害的家具仍可能被稍微穿过。
- 动作是程序化的姿势，不是动作捕捉，也不是由动作模型生成的。AI 仍在寻路网格上走路；物理只移动沙滩球，并检查动作的空间。
- 打字和坐姿的手臂动作是用两个示例 VRM 调出来的，体型大很多的模型仍可能碰到家具。
- 没有自动化测试。

## 灵感来源

- [Project AIRI](https://github.com/moeru-ai/airi)：自主驱动的 AI 伙伴这一想法。
- 《Generative Agents: Interactive Simulacra of Human Behavior》（Park 等，2023）：记忆与反思的设计。
- 《模拟人生》（The Sims）：基于可供性的物体设计。
