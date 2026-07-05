# Training Stride's own floor-plan recognition model

A CubiCasa-style specialized model, built in stages. The strategy: **synthetic
data first** (infinite, perfectly labeled, free), a compact segmentation
model, then Stride's existing geometry pipeline (`planProcess.js`) does the
vectorization heavy lifting it already does for Claude's output.

```
ml/generate.mjs      synthetic plan generator (image + mask + ground truth)
ml/train/dataset.py  loader + scan-degradation augmentations
ml/train/model.py    compact U-Net (~8M params @ base=32)
ml/train/train.py    training loop, per-class IoU, checkpoints
ml/train/infer.py    tiled inference → mask + Stride analyzer JSON
ml/train/vectorize.py  mask → walls/doors/windows (analyzer schema)
```

## Step 1 — Generate the dataset (no GPU needed)

```bash
node ml/generate.mjs --count 10000 --out ml/data/train --seed 1
node ml/generate.mjs --count 500   --out ml/data/val   --seed 999
```

~110 ms/sample → 10k samples in ~20 min, ~4 GB. Each sample: a stylized plan
drawing (`img_*.png`), a class mask (`msk_*.png`: black=bg, red=wall,
green=door, blue=window), and `gt_*.json` in the exact schema Stride's Claude
analyzer emits.

The generator randomizes *drawing style* (wall fills: solid/double-line/
gray/hatched; fonts; dimension chains in m or mm; furniture distractors;
grid/dot paper; north arrows) so the model learns geometry, not style.
The training loader randomizes *capture conditions* (JPEG artifacts, blur,
noise, contrast, grayscale) so it survives phone photos and old scans.

## Step 2 — Train

### Easiest: one-click Colab (free GPU, no setup)

Open **[`ml/colab_train.ipynb`](https://colab.research.google.com/github/tiienn/stride/blob/main-uiyymm/ml/colab_train.ipynb)** in Google Colab, set the runtime to a T4 GPU (Runtime → Change runtime type → T4 GPU), then **Runtime → Run all**. It clones the repo, generates the dataset, trains, previews a prediction, exports ONNX, and downloads `best.pt` + `stride-planseg.onnx`. Lower `SAMPLES`/`EPOCHS` in the config cell for a quick end-to-end test first.

### Or locally / on your own GPU

Needs a GPU for real runs (any consumer card works; Colab's free T4 is fine).

```bash
pip install -r ml/train/requirements.txt
python ml/train/train.py --data ml/data/train --epochs 30 --batch 8 --size 512
```

- RTX 3060/4070-class: a few hours to ~0.9 wall IoU on 10k samples.
- Colab: upload `ml/` + a generated dataset zip, same command.
- CPU smoke test (verifies the loop, not a real model):
  `python ml/train/train.py --data ml/data/train --size 256 --batch 2 --base 16 --workers 0 --max-steps 40`

Watch `val IoU` per class. Doors/windows lag walls (they're rare pixels) —
that's normal; the class weights in `train.py` already compensate. Targets
for a useful v1: wall ≥ 0.85, door ≥ 0.6, window ≥ 0.6.

## Step 3 — Inference → Stride

```bash
python ml/train/infer.py --checkpoint ml/checkpoints/best.pt \
    --image ml/data/val/img_00007.png --out-prefix /tmp/pred
```

Writes `/tmp/pred_mask.png` + `/tmp/pred_analysis.json`. The JSON is in the
analyzer schema, so in Stride it goes straight through
`analysisToScenePlan()` — snapping, room flood-fill, door-width enforcement
and access repair all apply to model output exactly as they do to Claude's.

## Step 4 — Ship it

Two options, in order of preference:

1. **In the browser** (recommended): export to ONNX and run with
   onnxruntime-web (WebGPU/WASM). Zero API cost, zero server, works offline.
   ```python
   import torch; from model import UNet
   m = UNet(4, base=32); m.load_state_dict(torch.load('ml/checkpoints/best.pt')); m.eval()
   torch.onnx.export(m, torch.zeros(1,3,512,512), 'stride-planseg.onnx',
                     input_names=['image'], output_names=['logits'],
                     dynamic_axes={'image': {2:'h', 3:'w'}})
   ```
   Then in Stride: run tiled inference in a web worker, `vectorize` logic
   ported to JS (it's ~100 lines), feed `analysisToScenePlan`.
2. **Serverless GPU** (Modal/Replicate): keep Python inference as-is behind
   an endpoint; call it from `/api/analyze` before/instead of Claude.

Either way, keep Claude in the loop for what segmentation can't do: room
*names/types* from text labels, printed-dimension scale, plan-type
classification, site plans. Best architecture: model geometry + Claude
semantics, merged before `analysisToScenePlan`.

## Step 5 — Level up with real data

Synthetic-only models plateau on messy real-world drawings. In order of
effort:

1. **Harder synthetics**: L/T/U-shaped footprints, diagonal walls, curved
   walls, stairs, multi-unit plans, blueprint (white-on-blue) style,
   perspective/keystone warp of the whole page, handwriting-style fonts.
2. **CubiCasa5K** (5k annotated real plans) — prototype/benchmark only, it's
   CC BY-NC (non-commercial). Great for measuring the synthetic-to-real gap.
3. **Your own data flywheel**: consented Stride uploads + an in-app "fix this
   wall" editor → corrections become training labels. Annotate extras with
   CVAT or Label Studio. Even 200 real annotated plans mixed 1:10 with
   synthetics moves accuracy substantially.

## Roadmap recap

- [x] Synthetic generator (image + mask + analyzer-schema ground truth)
- [x] Training pipeline (U-Net, augmentations, IoU tracking)
- [x] Inference + vectorization into Stride's pipeline
- [ ] Real training run on GPU (10k samples, 30 epochs)
- [ ] Benchmark vs. Claude-only on held-out plans (val set + real plans)
- [ ] ONNX export + browser inference in Stride
- [ ] Harder synthetics / real-data flywheel
