# Motion clips from Kimodo

The avatars walk and stand about with motion clips made by [Kimodo](https://github.com/nv-tlabs/kimodo), NVIDIA's text-to-motion model. The game plays them as VRM animations (`.vrma`) from `public/motions` (see `src/clips.ts`). Without clips, the game uses its procedural motion only.

## What is here

| File | What it does |
| --- | --- |
| `make_clips.py` | Runs Kimodo for each prompt in its `CLIPS` list, converts every sample, and writes `public/motions/index.json`. |
| `bvh_to_vrma.py` | Converts one Kimodo BVH (SOMA skeleton, T-pose rest) into a `.vrma`. With `--loop walk` it cuts one stride and keeps it in place. With `--loop idle` it blends the end into the start. Needs only numpy. |

## Setup

1. Install Kimodo in its own Python 3.11 environment, with a CUDA build of PyTorch. See the [Kimodo install guide](https://research.nvidia.com/labs/sil/projects/kimodo/docs/getting_started/installation.html).
   On Windows without a C++ compiler, set `SKIP_MOTION_CORRECTION_IN_SETUP=1` before installing. Kimodo then runs without its foot-skate cleanup, so generate with `--no-postprocess`.
2. Kimodo's text encoder is Llama 3 8B, a gated model. Request access to `meta-llama/Meta-Llama-3-8B-Instruct` on Hugging Face, then log in with `hf auth login`.
3. With less than about 17 GB of GPU memory, keep the text encoder on the CPU: `TEXT_ENCODER_DEVICE=cpu`. `make_clips.py` sets this by default.

## Make the clips

```sh
<kimodo env>/python tools/kimodo/make_clips.py --work <folder for Kimodo's raw output>
```

Use `--only walk_relaxed` to make one entry again. Kimodo's raw output (NPZ, BVH) stays in the work folder, outside the repository.

## Licenses

The Kimodo code is Apache-2.0. The Kimodo SOMA models are under the NVIDIA Open Model License, and the text encoder is under the Meta Llama 3 license. Check both before you publish clips made with them.
