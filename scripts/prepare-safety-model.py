"""Reproduce the bundled offline CLIP assets. Network is used only at build time.

Requires Python, numpy and onnxruntime. No user images are uploaded.
"""
from pathlib import Path
import hashlib
import json
import re
import urllib.request
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models" / "clip-vit-base-patch32"
BUILD = ROOT / "output" / "safety-model-build"
VENDOR = ROOT / "vendor" / "onnxruntime-web"
REVISION = "d15189d7028b43f1d3e65039190477f6af591c2a"
MODEL_BASE = f"https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/{REVISION}/"
ORT_VERSION = "1.20.1"

# Descriptive English CLIP prompts, not a trained or medically validated detector.
PROMPTS = {
    "sexual": [
        "a sexually explicit pornographic photo",
        "a photo of naked people having sex",
        "a close up photo of exposed human genitals",
        "a photo of a naked woman with bare breasts",
        "a photo of a naked man with an exposed penis",
        "a pornographic drawing of naked anime characters having sex",
        "a sexually explicit hentai illustration",
        "a photo of a nude person posing erotically",
    ],
    "blocked": [
        "a graphic photo of a mutilated dead body",
        "a graphic photo of exposed internal organs and gore",
        "a graphic photo of a severed human limb",
        "a photo of a gruesome bloody injury and an open wound",
        "a photo of a decomposing human corpse",
        "a graphic photo of animal cruelty with blood and dead animals",
        "a disturbing close up photo of a severe skin disease",
        "a photo of vomit and human feces",
        "a disgusting photo of maggots inside an infected wound",
        "a graphic photo of a surgical operation with exposed organs",
    ],
    "safe": [
        "a photo of a smiling person",
        "a photo of people wearing clothes",
        "a photo of a cat",
        "a photo of a dog",
        "a photo of a beautiful outdoor landscape",
        "a photo of delicious cooked food on a plate",
        "a photo of fruit and vegetables",
        "a screenshot of a website with text",
        "a screenshot of a video game",
        "a drawing of an anime character",
        "a funny internet meme with text",
        "a photo of a car",
        "a photo of a train",
        "a photo of a building",
        "a photo of a room",
        "a photo of an electronic device",
        "a photo of flowers and plants",
        "a simple illustration",
        "a diagram",
        "a photo of a bird",
        "a photo of a wild animal",
        "a photo of a sports event",
        "a photo of a musical performance",
    ],
}


def download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        print(f"Downloading {target.relative_to(ROOT)}", flush=True)
        temporary = target.with_suffix(target.suffix + ".part")
        urllib.request.urlretrieve(url, temporary)
        temporary.replace(target)
    return target


def ascii_clip_tokens(text, tokenizer):
    """CLIP BPE for the fixed, lowercase ASCII-only prompts in this file."""
    if not text.isascii() or text != text.lower():
        raise ValueError("Only fixed lowercase ASCII prompts are supported")
    vocab = tokenizer["model"]["vocab"]
    ranks = {}
    for index, merge in enumerate(tokenizer["model"]["merges"]):
        ranks[tuple(merge.split() if isinstance(merge, str) else merge)] = index
    result = [vocab["<|startoftext|>"]]
    for token in re.findall(r"[a-z]+|[0-9]|[^\s\w]+", text):
        word = list(token[:-1]) + [token[-1] + "</w>"]
        while len(word) > 1:
            pairs = [(word[i], word[i + 1]) for i in range(len(word) - 1)]
            pair = min(pairs, key=lambda value: ranks.get(value, float("inf")))
            if pair not in ranks:
                break
            merged = []
            i = 0
            while i < len(word):
                if i + 1 < len(word) and (word[i], word[i + 1]) == pair:
                    merged.append(word[i] + word[i + 1])
                    i += 2
                else:
                    merged.append(word[i])
                    i += 1
            word = merged
        result.extend(vocab[value] for value in word)
    result.append(vocab["<|endoftext|>"])
    if len(result) > 77:
        raise ValueError("CLIP prompt exceeds its context length")
    return result


def main():
    for name in ["vision_model_quantized.onnx"]:
        download(MODEL_BASE + "onnx/" + name, MODEL / name)
    for name in ["config.json", "preprocessor_config.json", "README.md"]:
        download(MODEL_BASE + name, MODEL / name)
    tokenizer_path = download(MODEL_BASE + "tokenizer.json", BUILD / "tokenizer.json")
    text_path = download(MODEL_BASE + "onnx/text_model.onnx", BUILD / "text_model.onnx")
    download("https://raw.githubusercontent.com/openai/CLIP/a1d071733d7111c9c014f024669f959182114e33/LICENSE", MODEL / "LICENSE.txt")
    for name in ["ort.wasm.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]:
        download(f"https://unpkg.com/onnxruntime-web@{ORT_VERSION}/dist/{name}", VENDOR / name)
    download(f"https://raw.githubusercontent.com/microsoft/onnxruntime/v{ORT_VERSION}/LICENSE", VENDOR / "LICENSE")
    download(f"https://raw.githubusercontent.com/microsoft/onnxruntime/v{ORT_VERSION}/ThirdPartyNotices.txt", VENDOR / "ThirdPartyNotices.txt")

    tokenizer = json.loads(tokenizer_path.read_text(encoding="utf-8"))
    session = ort.InferenceSession(str(text_path), providers=["CPUExecutionProvider"])
    print("Text model inputs:", [(item.name, item.type, item.shape) for item in session.get_inputs()], flush=True)
    embeddings = []
    for category, prompts in PROMPTS.items():
        for prompt in prompts:
            tokens = np.asarray([ascii_clip_tokens(prompt, tokenizer)], dtype=np.int64)
            inputs = {"input_ids": tokens}
            if any(item.name == "attention_mask" for item in session.get_inputs()):
                inputs["attention_mask"] = np.ones_like(tokens)
            vector = session.run(["text_embeds"], inputs)[0][0].astype(np.float64)
            vector /= np.linalg.norm(vector)
            embeddings.append({"category": category, "prompt": prompt, "embedding": [round(float(value), 9) for value in vector]})
    payload = {"version": 1, "model": "Xenova/clip-vit-base-patch32", "revision": REVISION,
               "method": "fixed lowercase ASCII CLIP BPE, float32 text projection, L2 normalization",
               "prompts": embeddings}
    (MODEL / "safety-prompts.json").write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
    inventory = []
    for target in sorted([*MODEL.iterdir(), *VENDOR.iterdir()]):
        if target.is_file() and target.name != "asset-integrity.json":
            inventory.append({"path": target.relative_to(ROOT).as_posix(), "bytes": target.stat().st_size,
                              "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    (MODEL / "asset-integrity.json").write_text(json.dumps({"modelRevision": REVISION, "onnxruntimeVersion": ORT_VERSION, "files": inventory}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"prompts": len(embeddings), "packagedBytes": sum(item["bytes"] for item in inventory)}), flush=True)


if __name__ == "__main__":
    main()
