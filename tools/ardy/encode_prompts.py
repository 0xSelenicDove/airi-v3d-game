"""
Encode the gesture prompts once and keep the result, so the live server never loads the text model.

The text encoder (LLM2Vec on Llama 3 8B) needs about 14 GB of VRAM or 16 GB of RAM. It runs here, on the CPU, in its
own process. It is forced to the local model: ARDY's default mode first tries a hosted text service, and prompts stay
on this machine.

Usage: python encode_prompts.py --text-encoders DIR --out FILE.npz [--prompts prompts.json]
Prompts already in the output file are kept and not encoded again.
"""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--text-encoders', required=True, help='folder holding McGill-NLP and meta-llama')
parser.add_argument('--out', required=True)
parser.add_argument('--prompts', default=str(Path(__file__).with_name('prompts.json')))
args = parser.parse_args()

os.environ['TEXT_ENCODERS_DIR'] = args.text_encoders
os.environ['TEXT_ENCODER_DEVICE'] = 'cpu'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

prompts = json.loads(Path(args.prompts).read_text(encoding='utf-8'))
key = lambda text: hashlib.sha1(text.encode('utf-8')).hexdigest()

cache = {}
if os.path.exists(args.out):
    with np.load(args.out) as old:
        cache = {k: old[k] for k in old.files}
todo = [t for t in prompts.values() if key(t) not in cache]
print(f'{len(prompts)} prompts, {len(todo)} to encode', flush=True)

if todo:
    import torch

    # NOTICE:
    # This runs in the Kimodo environment, which holds the same LLM2Vec model pair as ARDY's preset.
    # With transformers 5.8.1 (ARDY's environment), the adapter folder fails with "no file named model.safetensors".
    # transformers 5.1.0 (Kimodo's environment) loads it.
    # Remove this when ARDY's own load_text_encoder(mode='local') loads the same folder.
    from kimodo.model import LLM2VecEncoder

    t0 = time.time()
    encoder = LLM2VecEncoder(
        base_model_name_or_path='McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp',
        peft_model_name_or_path='McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised',
        dtype='bfloat16', llm_dim=4096, device='cpu',
    )
    print(f'text encoder loaded in {time.time() - t0:.0f} s', flush=True)
    for i, text in enumerate(todo):
        t0 = time.time()
        with torch.no_grad():
            feat, _ = encoder([text])
        cache[key(text)] = feat[0].float().cpu().numpy()
        print(f'{i + 1}/{len(todo)} {time.time() - t0:.1f} s  {cache[key(text)].shape}  {text}', flush=True)
        # saved after each prompt, so a stop part way keeps what is done
        tmp = args.out + '.tmp.npz'
        np.savez(tmp, **cache)
        os.replace(tmp, args.out)
print('done', flush=True)
