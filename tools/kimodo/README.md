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
