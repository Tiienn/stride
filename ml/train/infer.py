# Run the trained model on a plan image.
#
#   python ml/train/infer.py --checkpoint ml/checkpoints/best.pt \
#       --image some_plan.png --out-prefix /tmp/pred
#
# Writes <prefix>_mask.png (colored) and <prefix>_analysis.json (Stride
# analyzer schema — drop it into analysisToScenePlan()).
import argparse
import json

import numpy as np
import torch
from PIL import Image

from model import UNet
from vectorize import mask_to_analysis

PALETTE = np.array([[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]], dtype=np.uint8)


def predict(model, img: Image.Image, device, tile=512, overlap=64):
    """Tiled inference at (near-)native resolution so thin walls stay thin."""
    w, h = img.size
    scale = min(1.0, 1600 / max(w, h))
    if scale < 1.0:
        img = img.resize((int(w * scale), int(h * scale)), Image.BILINEAR)
    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    H, W = a.shape[:2]
    logits = np.zeros((4, H, W), dtype=np.float32)
    weight = np.zeros((H, W), dtype=np.float32)
    step = tile - overlap
    ys = list(range(0, max(1, H - tile + 1), step)) + [max(0, H - tile)]
    xs = list(range(0, max(1, W - tile + 1), step)) + [max(0, W - tile)]
    with torch.no_grad():
        for y0 in sorted(set(ys)):
            for x0 in sorted(set(xs)):
                patch = a[y0:y0 + tile, x0:x0 + tile]
                ph, pw = patch.shape[:2]
                pad = np.ones((tile, tile, 3), dtype=np.float32)
                pad[:ph, :pw] = patch
                x = torch.from_numpy(pad.transpose(2, 0, 1))[None].to(device)
                out = model(x)[0].cpu().numpy()
                logits[:, y0:y0 + ph, x0:x0 + pw] += out[:, :ph, :pw]
                weight[y0:y0 + ph, x0:x0 + pw] += 1
    return np.argmax(logits / np.maximum(weight, 1), axis=0), scale


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out-prefix", default="pred")
    ap.add_argument("--base", type=int, default=32)
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = UNet(4, base=args.base).to(device).eval()
    model.load_state_dict(torch.load(args.checkpoint, map_location=device))

    img = Image.open(args.image)
    classes, scale = predict(model, img, device)

    Image.fromarray(PALETTE[classes]).save(f"{args.out_prefix}_mask.png")
    analysis = mask_to_analysis(classes)
    if scale < 1.0:  # map pixel coords back to the original image resolution
        inv = 1.0 / scale
        for wall in analysis["walls"]:
            for k in ("start", "end"):
                wall[k]["x"] *= inv
                wall[k]["y"] *= inv
            wall["thickness"] *= inv
        for o in analysis["doors"] + analysis["windows"]:
            o["center"]["x"] *= inv
            o["center"]["y"] *= inv
            o["width"] *= inv
        analysis["imageSize"] = {"width": img.size[0], "height": img.size[1]}
    with open(f"{args.out_prefix}_analysis.json", "w") as f:
        json.dump(analysis, f, indent=1)
    print(f"wrote {args.out_prefix}_mask.png and {args.out_prefix}_analysis.json")
    print(f"walls: {len(analysis['walls'])}  doors: {len(analysis['doors'])}  windows: {len(analysis['windows'])}")


if __name__ == "__main__":
    main()
