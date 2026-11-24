# Live motion with ARDY

[ARDY](https://github.com/nv-tlabs/ardy) generates a character's standing, gestures, walking, running, sitting, standing up, and getting in and out of bed while the game runs. The game works without it.

- `ardy_server.py` streams motion to the game over a WebSocket on `127.0.0.1:8791`. Each character gets its own stream.
- `encode_prompts.py` encodes the prompts in `prompts.json` once, on the CPU, in the [Kimodo](https://github.com/nv-tlabs/kimodo) environment.
- `Assets/Scripts/Agents/LiveMotion.cs` plays the stream over the Animator's pose.

Live motion drives a character while it stands, while it walks or runs a NavMesh path with free hands, and while it sits, types, stands up, or gets in and out of bed. ARDY does not know about the room, so the game gives it each place, heading and hip height, and keeps hands on what they hold. Opening doors, moving the chair, the fridge and turning the quilt back stay on their clips. Without the server, every routine uses its clips.

## Set up

Install ARDY and download `ARDY-SOMA-RP-30FPS-Horizon60`. Then encode the prompts with the environment that holds the Llama 3 and LLM2Vec text models:

```bash
python encode_prompts.py --text-encoders TEXT_ENCODERS_DIR --out TEXT_CACHE/prompts.npz
```

The text model needs about 16 GB of RAM. It runs only here, and prompts already in the file are skipped. After you change `prompts.json`, run it again.

## Run

```bash
python ardy_server.py --checkpoints CHECKPOINTS_DIR --text-cache TEXT_CACHE/prompts.npz
```

Then start the game. It connects by itself and retries every 5 seconds. To use another address, start the game with `-ardy ws://127.0.0.1:PORT`. To turn live motion off, use `-ardy off`.

AIRI can play a gesture with `act`, type `gesture`, using a name from `world_status`. With `act`, type `interact`, `run: true` makes the character run there when the way is at least 3 m.

## Gestures

Most gestures are ARDY prompts in `prompts.json`, for example `squat`, `raise_arms`, `raise_left_arm`, `raise_right_arm` and `arms_forward`. Two are done in the game, over the generated standing body:

- `look_left` and `look_right` turn the neck and head 60 degrees. ARDY ignored "turn the head", and "look over the shoulder" turned the whole body.
- `swing_arms` swings the arms front to back in turn. The arm swing prompts left the arms still, or swung them out and across.

## Arms

These avatars have no twist bones. `LiveMotion` keeps each elbow a hinge, lets the forearm take half of the hand's roll, and keeps the generated bone directions. A hanging arm is centred at the side of the body, measured from the chest, and the swing around it stays. An arm can go only so far behind the body: 26 degrees when walking or standing, and 62 degrees when running.

## Licenses

The weights, the text models, and generated motion are not in this repository.

- ARDY and Kimodo code: Apache-2.0.
- ARDY and Kimodo weights: NVIDIA Open Model License.
- The text encoder uses Meta Llama 3 8B, under the Meta Llama 3 Community License.
