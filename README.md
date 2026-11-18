# AI World (airi-v3d-game)

**English** | [简体中文](README.zh-CN.md)

**[Live demo](https://0xselenicdove.github.io/airi-v3d-game/)** (runs with the mock brain and two public sample avatars; add your own `.vrm` models and LLM locally for the full experience)

A small 3D world that is driven entirely by AI. Think "VRChat, but the inhabitants are AIs": each AI has a VRM avatar, lives in a shared room, follows its own daily routine (sleeps, reads, uses the computer), remembers what happened, and talks to the others.

Built with TypeScript, [three.js](https://threejs.org/) and [@pixiv/three-vrm](https://github.com/pixiv/three-vrm). It runs in the browser; there is no backend.

> Status: working prototype. The agents run on a built-in rule-based "mock brain" by default. You can plug in any OpenAI-compatible LLM (your own model, Ollama, LM Studio, vLLM, ...), and it has been tried with one hosted model (Gemini 2.5 Flash via 302.ai, see below).

## Features

- **Autonomous agents** with needs (energy, fun, knowledge) that drive what they do, a persona, and a day/night clock.
- **Affordance-based world**: objects advertise what can be done with them (`bed → sleep`, `desk → use_computer`, `bookshelf → read`). The AI only picks high-level actions; the world handles walking and animation.
- **Pluggable brains**: a mock utility brain, or an OpenAI-compatible LLM brain with JSON-action parsing, timeouts, error feedback and automatic fallback.
- **Memory** in the style of *Generative Agents*: a memory stream, recall by recency + importance + relevance, periodic reflection into insights, and persistence across reloads (`localStorage`).
- **Multiple agents**: exclusive furniture (one person per bed/desk), speech that nearby agents actually hear, separate personas and sleep schedules.
- **Pathfinding**: grid A* around furniture and walls, with a debug overlay.
- **Behaviour rules** ([`src/skills/RULES.md`](src/skills/RULES.md)), carried out by skills and checked by tests: nothing passes through anything else; shoes come off before lying in bed; people sit on the bedside before lying down; the door is opened by its handle, slowly, and closed again behind them; and when the way is blocked, they stop and think about another route instead of pushing through.
- **Chance meetings**: agents walk at a relaxed pace, keep their personal space and pass each other on the right. When two meet, they may stop for small talk, wave hello, or walk on.
- **VRM avatars** with procedural animation: walking, sitting and typing, reading with a book, sleeping, breathing, blinking, talking gestures, looking at nearby agents. Each character has a way of walking and standing of its own, with random variation and idle fidgets.
- **Motion clips** (optional): walking and standing clips made with the Kimodo motion model ([`tools/kimodo`](tools/kimodo/README.md)), played as `.vrma` under the gestures and the hand IK.
- **Acting**: the LLM (or the mock brain) can make the body do something, such as wave, raise a hand or a leg, nod, bow, clap, point, stretch, cheer or jump, and set the face (happy, sad, angry, surprised, relaxed, shy). It works with any VRM.
- **World physics** ([Rapier](https://rapier.rs/)): furniture, walls, fences and trees are solid. A gesture plays only if the body has room for it, otherwise the model is told what is in the way. Jumps follow gravity, people push the beach balls around, and hair and clothes rest against nearby backrests, tables and walls.
- **In-world UI**: name tags, speech bubbles and thought bubbles above each agent.
- **Camera**: orbit / pan / zoom and a follow mode.
- **Voice**: agents speak aloud with the browser's built-in text-to-speech (a different voice per agent, quieter when far from the camera). It starts after your first click or key press.

## Quick start

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open http://localhost:5173.

### Add avatar models

Put your own models here (any VRM 0.x or 1.0 file works):

```
public/model.vrm    # first agent (Airi)
public/model2.vrm   # second agent (Luna)
```

Without them, the game uses two public sample avatars from the official VRM samples, in [`public/models/avatars`](public/models/avatars): **Seed-san model by VirtualCast, Inc.** for Luna, and VRM1_Constraint_Twist_Sample by pixiv Inc. for Airi. Both are under the [VRM Public License 1.0](https://vrm.dev/licenses/1.0/). The agents show as colored capsules until a model loads. You can also drag a `.vrm` file onto the page: it replaces the model of the agent on the half of the screen where you drop it.

## Controls

| Input | Action |
| --- | --- |
| Drag | Rotate the camera |
| Right-drag | Pan |
| Scroll | Zoom |
| `F` | Cycle follow-camera: Airi → Luna → free |
| `R` | Reset the view |
| `1` / `2` / `3` | Game speed (normal / fast / fastest) |
| `G` | Toggle the navigation debug overlay (blocked cells and routes) |
| `M` | Mute / unmute the agents' voices |

Add `?reset` to the URL (`http://localhost:5173/?reset`) to wipe saved memories and the clock.

## Using a real LLM

1. Copy `.env.example` to `.env.local`.
2. Set the endpoint and model:

   ```bash
   # Ollama:    http://localhost:11434/v1/chat/completions
   # LM Studio: http://localhost:1234/v1/chat/completions
   VITE_LLM_URL=http://localhost:11434/v1/chat/completions
   VITE_LLM_MODEL=your-model-name
   # VITE_LLM_KEY=
   ```

3. Restart `npm run dev` (Vite only reads env files at startup).

Optional: `VITE_LLM_SYSTEM_ROLE=1` sends the instructions as a real `system` message. By default they go inside the user message, because some hosted models (including the Gemini model below) follow the exact JSON format far more reliably that way.

The HUD shows `brain: LLM` when it is active. If a call fails or returns something unusable, the agent falls back to the mock brain and the HUD shows a warning.

Notes:

- The model is asked for one JSON action per turn, plus a short `thought`:
  `{"thought":"...","type":"interact","object":"desk","verb":"use_computer"}`. Other actions are `say`, `gesture` and `wait`.
- To act, the model adds `"emotion"` and `"gesture"` to `say`, or sends `{"type":"gesture","gesture":"nod"}`. It can also start what it says with tags, in the style of [LumenAct](https://github.com/AaBb-coder/LumenAct): `（微笑）（挥挥右手）早上好！` or `(smile)(wave) Morning!`. Chinese commands like `挥挥左手`, `把右手举高` and `抬起右腿` (as in [HAST-SEC](https://github.com/sola1039/HAST-SEC)) map to gestures. The full list is in [`src/acting.ts`](src/acting.ts).
- The prompt lists every legal action, and near-miss replies (e.g. `{"command":"sleep bed2"}`) are recovered when the intent is clear. The HUD brain stats are available in the console as `dbg.brain.stats` (`strict` / `coerced` / `failed`).
- If the model picks something that does not exist, the error is returned to it on its next turn.
- Everything is called directly from the browser. If your server blocks cross-origin requests, allow `http://localhost:5173` (for Ollama, set `OLLAMA_ORIGINS`).
- Anything in a `VITE_` variable is visible in the browser, so do not put a production API key there.

## How it works

```
World (clock, objects, occupancy, speech) ── Agent (needs, state machine, memory) ── Brain (decide / reflect)
            │                                              │
            └──────────── Avatar (VRM, poses, bubbles) ◄───┘          three.js scene + camera
```

Each agent runs two loops. A **slow loop** asks the brain for the next action only when the agent is idle; the **fast loop** (walking, animation, needs decay) runs every frame without the model. This keeps LLM cost and latency low.

| File | What it does |
| --- | --- |
| [`src/world.ts`](src/world.ts) | Clock, objects and their affordances (from `src/room-layout.json`), occupancy, speech broadcast, navigation grid and A* |
| [`src/agent.ts`](src/agent.ts) | Agent state machine, needs, observations, action validation, reflection trigger, walking and avoiding others |
| [`src/social.ts`](src/social.ts) | Chance meetings: greetings, waves and small talk when two agents meet |
| [`src/skills/`](src/skills) | Behaviour rules and the skills that carry them out: going to bed, using the door, finding another way |
| [`src/acting.ts`](src/acting.ts) | Gestures and emotions the agents can act out, and the words and tags the LLM may use for them |
| [`src/physics.ts`](src/physics.ts) | Rapier world: solid scenery, the agents' bodies, beach balls, and the space checks for gestures |
| [`src/brain.ts`](src/brain.ts) | `MockBrain`, `LLMBrain`, JSON action parsing |
| [`src/memory.ts`](src/memory.ts) | Memory stream, scored retrieval, pruning, (de)serialization |
| [`src/avatar.ts`](src/avatar.ts) | VRM loading, procedural animation, name tags and bubbles |
| [`src/main.ts`](src/main.ts) | Scene, room model, camera, persistence, debug overlay |
| [`src/types.ts`](src/types.ts) | Shared types (actions, observations, personas) |

### Customizing

- **Add a persona**: add an entry to `personas` in `src/main.ts` (name, description, color, sleep window, bed) and a start position. Give it a bed in `src/world.ts`.
- **Add an object**: place the furniture and its interaction in `tools/blender/build_room.py` and run it again (see below). The game reads the objects from `src/room-layout.json` and draws `public/models/room.glb`.
- **Use your own model**: implement the `Brain` interface (`decide`, optionally `reflect`) in `src/brain.ts` and pass it to the agents in `src/main.ts`.

### Room model (Blender)

[`tools/blender/build_room.py`](tools/blender/build_room.py) assembles a furnished single room in Blender from the low-poly [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) (CC0). The models it uses are in [`assets/kenney-furniture-kit`](assets/kenney-furniture-kit). The room has two beds, a wardrobe, a sofa, an armchair, a TV, a desk, a bookshelf, a kitchen with a fridge, sink and cooker, a dining table with stools, a washing machine, windows and a door. The game loads it at startup, and hides each wall that is between the camera and the room.

The room is light: about 8,600 triangles, about 130 draw calls, no textures, and a GLB of about 500 KB.

```bash
blender -b --factory-startup -P tools/blender/build_room.py -- --repo .
```

It writes three files:

| File | Content |
| --- | --- |
| `public/models/room.glb` | The room for three.js. Each piece of furniture is a `FURN_<id>` node. Interaction points are `IP_<id>_use` and `IP_<id>_approach` nodes. |
| `src/room-layout.json` | Furniture footprints and interaction objects (`pos`, `usePos`, `approach`, `affordances`) in game coordinates, in the same shape as `WorldObject`. `src/world.ts` imports it. |
| `assets/room.blend` | The same scene for editing in Blender. |

The script stops with an error in these cases:

- Two pieces of furniture intersect. It tests the real mesh triangles.
- A sitting, lying or standing avatar would clip into furniture. It uses the poses in `src/avatar.ts`.
- A seat or bed has the wrong height for those poses.
- An interaction point cannot be reached on the navigation grid.

Add `--render <dir>` to also save preview images.

## Known limitations

- Only memories and the world clock are saved across reloads; positions and needs reset.
- Relevance in memory recall is keyword overlap, not embeddings.
- Without clips in `public/motions`, animation is procedural, so it is stiffer than real motion. Clips cover walking and standing only.
- Small talk in chance meetings uses fixed lines picked for the situation, not the LLM.
- Someone who blocks the only way through (a full gate) makes a walker wait and finally give up; nobody is pushed aside.
- The LLM brain has only been tried with Gemini 2.5 Flash (no thinking) through 302.ai: about 2-3 s per decision, 10 of 11 replies exactly in format and 1 recovered, in a ~100 s run. Other models may need prompt tweaks. Agents also tend to chat repetitively.
- Hair and clothes rest against the nearest surface in each direction (a plane), so a strongly curved piece of furniture can still be crossed a little.
- Gestures are procedural poses, not motion captured or generated by a motion model. Agents walk on the navigation grid; physics moves only the balls and checks the space for gestures.
- The arm poses for typing and sitting were tuned with two sample VRMs. A much larger model can still touch the furniture.
- No automated tests.

## Inspiration

- [Project AIRI](https://github.com/moeru-ai/airi) for the idea of a self-driven AI companion.
- *Generative Agents: Interactive Simulacra of Human Behavior* (Park et al., 2023) for the memory / reflection design.
- *The Sims* for affordance-based objects.
