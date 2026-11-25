# Kimodo

[Kimodo](https://github.com/nv-tlabs/kimodo) is NVIDIA's text-to-motion model. The game uses it for live motion, and it can also make motion clips.

## Live motion

`kimodo_server.py` generates each character's motion while the game runs: standing, gestures, walking and running. It is the game's default motion server. It speaks the same protocol as the [ARDY server](../ardy/README.md), and both use `../ardy/plans.py` for paths, furniture steps and standing still.

- Kimodo makes 3 s of motion at a time. Each part starts on the last 5 frames of the part before it, and the seam fades out over the next frames.
- The game gives each part its path, places, headings and hip heights as Kimodo constraints.
- The bed and the desk are left to the game's clips. The server does not offer the prompts `motion_lie_down`, `motion_lie`, `motion_get_up`, `motion_sit_down`, `motion_sit`, `motion_type` and `motion_stand_up`, so the game uses its clips for them. With Kimodo, lying down dropped back fast and swung an arm into the wall, and getting up stayed lying through the sitting up. At the desk, typing slumped back in the chair, and standing up ended lying on the floor.
- Kimodo carries on the pose that a part starts in. Without help, a character stayed crouched after `squat`, and raised arms stayed up. So from 0.8 s into an `idle` or `relax` part, the server holds the hips at standing height, the hands at the sides, and the facing. The standing height and the hand places come from Kimodo's own standing, measured when the server starts.
- AIRI can describe a motion in English with `act`, type `gesture`, field `motion`, for example "a person stretches both arms over their head".

Measured on a laptop RTX 5070 (8 GB), with 30 denoising steps:

| | |
| --- | --- |
| One 3 s part | about 1.2 s, 1.2 GB of GPU memory |
| A change starts | about 1.5 s after it is asked (ARDY: about 0.3 s) |
| Path following | 4 to 5 cm from the path on average, 3 cm at the end |
| Seams | 0.3 to 10 degrees in one frame, the larger ones while walking |
| A new description | about 25 s to load the text model, then about 0.5 s for each one |

### Set up

Use the Kimodo environment from [Setup](#setup) below, and add the WebSocket package:

```sh
<kimodo env>/python -m pip install websockets==17.4
```

### Run

```sh
<kimodo env>/python tools/kimodo/kimodo_server.py --text-encoders TEXT_ENCODERS_DIR --checkpoints CHECKPOINT_DIR --text-cache TEXT_CACHE/prompts.npz
```

- The server listens on `127.0.0.1:8793`. Use `--port` to change it, and `--steps` for fewer or more denoising steps.
- At the first start, it encodes the prompts in `../ardy/prompts.json` into the text cache. Then it frees the text model.
- The text model loads again only for a new description, and it is freed after 5 minutes with nothing to encode. It needs about 16 GB of RAM.
- Descriptions are kept in the text cache, so each one is encoded only once.

Then start the game. It connects by itself and retries every 5 seconds.

| Game argument | Motion |
| --- | --- |
| none, or `-motion kimodo` | Kimodo on `127.0.0.1:8793` |
| `-motion ardy` | ARDY on `127.0.0.1:8791` |
| `-motion ws://127.0.0.1:PORT` | the server at that address |
| `-motion off` | the clips only |

### What Kimodo does well and badly

From 3 tries of each prompt:

- Squatting and standing up, and raising both arms and lowering them, worked every time.
- Turning the head to the right worked every time. Turning it to the left went the wrong way or barely turned in 2 of 3 tries. So `look_left` and `look_right` stay in the game, the same as with ARDY.
- The arm swing prompt left the arms almost still, so `swing_arms` also stays in the game.

## Motion clips

The three.js version of the game walked and stood with motion clips made by Kimodo, played as VRM animations (`.vrma`) from `public/motions`. The Unity version does not use these clips.

| File | What it does |
| --- | --- |
| `kimodo_server.py` | The live motion server (see [Live motion](#live-motion)). |
| `make_clips.py` | Runs Kimodo for each prompt in its `CLIPS` list, converts every sample, and writes `public/motions/index.json`. |
| `bvh_to_vrma.py` | Converts one Kimodo BVH (SOMA skeleton, T-pose rest) into a `.vrma`. With `--loop walk` it cuts one stride and keeps it in place. With `--loop idle` it blends the end into the start. Needs only numpy. |

## Setup

1. Install Kimodo in its own Python 3.11 environment, with a CUDA build of PyTorch. See the [Kimodo install guide](https://research.nvidia.com/labs/sil/projects/kimodo/docs/getting_started/installation.html).
   On Windows without a C++ compiler, set `SKIP_MOTION_CORRECTION_IN_SETUP=1` before installing. Kimodo then runs without its foot-skate cleanup, so generate with `--no-postprocess`.
2. Kimodo's text encoder is Llama 3 8B, a gated model. Request access to `meta-llama/Meta-Llama-3-8B-Instruct` on Hugging Face, then log in with `hf auth login`.
   If access is not granted, use a local copy instead:
   - Put the encoder files in one folder, for example `text-encoders/`.
     - `McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` and `McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised` (the two adapters).
     - `meta-llama/Meta-Llama-3-8B-Instruct` (the base weights). An ungated copy with the same weights, for example `NousResearch/Meta-Llama-3-8B-Instruct`, works here.
   - In both `adapter_config.json` files, set `base_model_name_or_path` to the absolute path of the base weights folder.
   - Set `TEXT_ENCODERS_DIR` to the folder before you run `make_clips.py`.
   - Check each `.safetensors` file against the sha256 that Hugging Face lists for it.
3. With less than about 17 GB of GPU memory, keep the text encoder on the CPU: `TEXT_ENCODER_DEVICE=cpu`. `make_clips.py` sets this by default.
   The encoder loads in bfloat16, so it needs about 16 GB of free RAM.
4. Kimodo downloads its motion model (`nvidia/Kimodo-SOMA-RP-v1.2`, about 1.1 GB) on the first run.
   If that download fails, put the model files in `<folder>/Kimodo-SOMA-RP-v1.2`. Then set `CHECKPOINT_DIR=<folder>` and `HF_HUB_OFFLINE=1`.

## Make the clips

```sh
<kimodo env>/python tools/kimodo/make_clips.py --work <folder for Kimodo's raw output>
```

Use `--only walk_relaxed` to make one entry again. Kimodo's raw output (NPZ, BVH) stays in the work folder, outside the repository.

## Licenses

The Kimodo code is Apache-2.0. The Kimodo SOMA models are under the NVIDIA Open Model License, and the text encoder is under the Meta Llama 3 license. Check both before you publish clips made with them.
