"""
Make the game's motion clips with Kimodo (nv-tlabs/kimodo) and convert them to VRM animations.

For each entry in CLIPS, this runs `kimodo_gen` (several samples, BVH with a T-pose rest), converts every sample
with bvh_to_vrma.py into public/motions, and writes public/motions/index.json, which the game reads (src/clips.ts).

Run it with the Python of the environment Kimodo is installed in, for example:
    <kimodo env>/python tools/kimodo/make_clips.py --work <folder for Kimodo's raw output>
Set HF_HOME to where your Hugging Face login is saved (Kimodo's text encoder, Llama 3, is a gated model).
With a GPU of less than about 17 GB, keep TEXT_ENCODER_DEVICE=cpu (the default here).
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

# name, kind, prompt, seconds, samples
CLIPS = [
    ('walk_relaxed', 'walk', 'A person walks forward at a relaxed, natural pace.', 6.0, 3),
    ('walk_casual', 'walk', 'A person walks forward casually, swinging the arms lightly.', 6.0, 2),
    ('idle_calm', 'idle', 'A person stands still in a relaxed pose, breathing calmly.', 8.0, 2),
    ('idle_shift', 'idle', 'A person stands relaxed, shifting weight from one foot to the other and looking around.', 8.0, 2),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--work', required=True, help="folder for Kimodo's raw output (NPZ, BVH)")
    ap.add_argument('--out', default=str(REPO / 'public' / 'motions'))
    ap.add_argument('--only', nargs='*', help='make only these clips (by name)')
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()
    work, out = Path(a.work), Path(a.out)
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    env = {**os.environ}
    env.setdefault('TEXT_ENCODER_DEVICE', 'cpu')
    gen = Path(sys.executable).parent / ('kimodo_gen.exe' if os.name == 'nt' else 'kimodo_gen')

    index_path = out / 'index.json'
    index = json.loads(index_path.read_text(encoding='utf-8')) if index_path.exists() else []
    for name, kind, prompt, secs, samples in CLIPS:
        if a.only and name not in a.only:
            continue
        stem = work / name
        print(f'== {name}: "{prompt}" ({samples} x {secs} s)', flush=True)
        subprocess.run([str(gen), prompt, '--duration', str(secs), '--num_samples', str(samples), '--seed', str(a.seed),
                        '--output', str(stem), '--bvh', '--bvh_standard_tpose',
                        *(['--no-postprocess'] if not has_motion_correction() else [])], check=True, env=env)
        bvhs = sorted(stem.glob('*.bvh')) if stem.is_dir() else [stem.with_suffix('.bvh')]
        index = [c for c in index if not c['file'].startswith(f'{name}_')]
        for i, bvh in enumerate(bvhs):
            file = f'{name}_{i:02d}.vrma'
            res = subprocess.run([sys.executable, str(HERE / 'bvh_to_vrma.py'), str(bvh), str(out / file),
                                  '--loop', kind, '--name', name, '--prompt', prompt],
                                 capture_output=True, text=True)
            print(res.stdout.strip() or res.stderr.strip(), flush=True)
            if res.returncode != 0:
                continue
            meta = read_meta(out / file)
            entry = {'file': file, 'kind': kind, 'prompt': prompt}
            if kind == 'walk':
                entry['speed'] = meta.get('speed', 0)
            index.append(entry)
    index.sort(key=lambda c: c['file'])
    index_path.write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')
    print(f'{index_path}: {len(index)} clips')


def has_motion_correction():
    """Kimodo's optional foot-skate cleanup (a C++ extension) is installed"""
    import importlib.util
    return importlib.util.find_spec('motion_correction') is not None


def read_meta(path: Path):
    """the converter's notes (loop, speed, prompt) from a .vrma file's animation extras"""
    import struct
    data = path.read_bytes()
    n = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + n])
    return gltf['animations'][0].get('extras', {})


if __name__ == '__main__':
    main()
