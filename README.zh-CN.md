# AI World（airi-v3d-game）

[English](README.md) | **简体中文**

一个完全由 AI 驱动的小型 3D 世界。可以把它理解成「VRChat，但里面的居民是 AI」：每个 AI 都有自己的 VRM 形象，住在同一个房间里，有自己的生活规律（睡觉、读书、用电脑），会记住发生过的事，也会和其他 AI 聊天。

使用 TypeScript、[three.js](https://threejs.org/) 和 [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) 构建，直接在浏览器里运行，没有后端。

> 当前状态：可运行的原型。默认使用内置的规则型「模拟大脑」驱动 AI。你可以接入任何兼容 OpenAI 接口的大模型（自己的模型、Ollama、LM Studio、vLLM 等），但这条路径目前只用假服务器测试过，还没有用真实模型试过。

## 功能

- **自主的 AI 居民**：有能量、娱乐、知识三种需求来驱动行为，有人设，还有昼夜时钟。
- **基于「可供性」的世界**：物体会声明自己能做什么（`床 → 睡觉`、`电脑桌 → 用电脑`、`书架 → 读书`）。AI 只选择高层动作，走路和动画由世界处理。
- **可替换的大脑**：模拟的效用型大脑，或兼容 OpenAI 接口的 LLM 大脑（带 JSON 动作解析、超时、错误反馈和自动回退）。
- **记忆系统**（参考《Generative Agents》）：记忆流、按时效 + 重要性 + 相关性检索、定期反思生成「感悟」，并通过 `localStorage` 在刷新后保留。
- **多 AI 共存**：家具同一时间只能一个人使用（一张床、一张桌子一个人），附近的 AI 能真正听到说话内容，每个 AI 有各自的人设和作息。
- **寻路**：在家具和墙壁之间用网格 A* 绕行，并带调试可视化。
- **VRM 形象**与程序化动画：走路、坐着打字、拿书阅读、睡觉、呼吸、眨眼、说话手势、看向附近的 AI。
- **场景内 UI**：头顶的名字标签、对话气泡和思考气泡。
- **相机**：旋转 / 平移 / 缩放，以及跟随模式。

## 快速开始

需要 Node.js 18 及以上。

```bash
npm install
npm run dev
```

然后打开 http://localhost:5173。

### 添加角色模型

仓库里不包含任何 `.vrm` 文件。请把你自己的模型放到这里（VRM 0.x 和 1.0 都可以）：

```
public/model.vrm    # 第一个 AI（Airi）
public/model2.vrm   # 第二个 AI（Luna）
```

没有模型时，AI 会显示为彩色胶囊体。你也可以把 `.vrm` 文件直接拖到页面上：拖到屏幕左半边会替换第一个 AI 的模型，右半边则替换第二个。

## 操作

| 输入 | 作用 |
| --- | --- |
| 拖动 | 旋转相机 |
| 右键拖动 | 平移 |
| 滚轮 | 缩放 |
| `F` | 切换跟随相机：Airi → Luna → 自由视角 |
| `R` | 重置视角 |
| `1` / `2` / `3` | 游戏速度（正常 / 快 / 最快） |
| `G` | 开关寻路调试层（不可走区域和路线） |

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

启用后界面左上角会显示 `brain: LLM`。如果某次调用失败或返回内容无法解析，AI 会回退到模拟大脑，并在界面上显示警告。

说明：

- 每一轮会要求模型返回一个 JSON 动作，外加一句简短的 `thought`（想法）：
  `{"thought":"...","type":"interact","object":"desk","verb":"use_computer"}`。其他动作有 `say`（说话）和 `wait`（等待）。
- 如果模型选了不存在的物体或动作，错误信息会在它下一轮的观察里返回给它。
- 所有请求都由浏览器直接发出。如果你的服务器拦截跨域请求，请允许 `http://localhost:5173`（Ollama 需要设置 `OLLAMA_ORIGINS`）。
- 任何 `VITE_` 开头的变量都会暴露在浏览器里，请不要在这里放正式环境的 API 密钥。

## 工作原理

```
World（时钟、物体、占用、说话） ── Agent（需求、状态机、记忆） ── Brain（决策 / 反思）
            │                                        │
            └──────── Avatar（VRM、姿势、气泡） ◄────┘          three.js 场景 + 相机
```

每个 AI 有两个循环。**慢循环**只在 AI 空闲时向大脑要下一个动作；**快循环**（走路、动画、需求衰减）每帧运行，不需要模型参与。这样可以控制大模型的费用和延迟。

| 文件 | 作用 |
| --- | --- |
| [`src/world.ts`](src/world.ts) | 时钟、物体及其可供性、占用、说话广播、寻路网格和 A* |
| [`src/agent.ts`](src/agent.ts) | AI 状态机、需求、观察、动作校验、触发反思 |
| [`src/brain.ts`](src/brain.ts) | `MockBrain`、`LLMBrain`、JSON 动作解析 |
| [`src/memory.ts`](src/memory.ts) | 记忆流、评分检索、淘汰、序列化 |
| [`src/avatar.ts`](src/avatar.ts) | VRM 加载、程序化动画、名字标签和气泡 |
| [`src/main.ts`](src/main.ts) | 场景、家具模型、相机、持久化、调试层 |
| [`src/types.ts`](src/types.ts) | 共享类型（动作、观察、人设） |

### 自定义

- **添加人设**：在 `src/main.ts` 的 `personas` 里加一项（名字、描述、颜色、睡眠时段、床），并加上出生位置，再在 `src/world.ts` 里给它一张床。
- **添加物体**：在 `src/world.ts` 的 `World` 里加入物体，写上 `affordances`，如果会挡路再加 `footprint`；同时在 `src/main.ts` 里加对应的模型。目前家具在这两处各定义了一次。
- **使用自己的模型**：在 `src/brain.ts` 里实现 `Brain` 接口（`decide`，可选 `reflect`），然后在 `src/main.ts` 里把它交给 AI。

## 已知限制

- 刷新后只保留记忆和世界时钟，位置和需求会重置。
- 记忆检索的「相关性」目前是关键词重合，不是向量嵌入。
- 动画是程序生成的，比真实动作片段更僵硬（后续可以支持 `.vrma` 动画片段）。
- AI 之间只用简单的推挤避让，在狭窄处迎面相遇可能显得别扭。
- LLM 大脑还没有用真实模型试过。
- 没有自动化测试。

## 灵感来源

- [Project AIRI](https://github.com/moeru-ai/airi)：自主驱动的 AI 伙伴这一想法。
- 《Generative Agents: Interactive Simulacra of Human Behavior》（Park 等，2023）：记忆与反思的设计。
- 《模拟人生》（The Sims）：基于可供性的物体设计。
