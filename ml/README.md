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

Open **[`ml/colab_train.ipynb`](https://colab.research.google.com/github/tiienn/stride/blob/main-uiyymm/ml/colab_train.ipynb)** in Google Colab, set the runtime to a T4 GPU (Runtime → Change runtime type → T4 GPU), then **Runtime → Run all**. It clones the repo, generates the dataset, trains, previews a prediction, exports ONNX, and saves `best.pt` + `stride-planseg.onnx` to your Google Drive. Lower `SAMPLES`/`EPOCHS` in the config cell for a quick end-to-end test first.

Colab's paid tiers (needed once the free daily GPU quota runs out) are only available in [a specific list of countries](https://research.google.com/colaboratory/faq.html) — if yours isn't on it, payment simply won't go through no matter what card/billing details you enter. Use the Kaggle notebook below instead in that case.

### Alternative: Kaggle Notebooks (free GPU, no payment method, no country restriction)

On [kaggle.com/code](https://www.kaggle.com/code), click **New Notebook**, then **File → Import Notebook → GitHub** and paste this repo's URL to `ml/kaggle_train.ipynb` (or download the file and use **Import Notebook → Upload** instead). Enable **Settings → Accelerator → GPU** and **Settings → Internet → On** in the panel on the right, then **Run All**.

Same pipeline as the Colab notebook, adapted for Kaggle's environment: it installs Node.js explicitly (Kaggle's base image doesn't ship it, unlike Colab's), works out of `/kaggle/working/` instead of `/content/`, and skips the Drive step entirely — the final cell collects both output files into `/kaggle/working/stride-model/`, downloadable straight from Kaggle's Output/file-browser pane. Kaggle gives every account roughly 30 hours/week of free GPU (T4 x2 or P100), no billing information required. First-time GPU/Internet use may require a one-time phone verification, unrelated to Stride.

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
- [x] Real training run (Colab T4, 10k samples, 30 epochs):
      val IoU wall 0.937 / door 0.845 / window 0.924;
      held-out (fresh seed, full-res) wall 0.966 / door 0.925 / window 0.945
- [x] Model published as the `model-v1` GitHub release
- [x] ONNX export + browser inference in Stride (onnxruntime-web wasm,
      src/lib/planseg.js; ~20-25s single-threaded, runs in parallel with the
      Claude call so uploads pay no extra latency)
- [x] Quality arbitration: build both candidate worlds (model geometry vs
      Claude geometry), score enclosure coverage minus dangling-wall penalty,
      ship the winner — a fragmented model read no longer beats Claude
- [x] Generator v2: open-plan rooms (no wall between kitchen/living),
      balconies with thin railings + sliding doors (railing ≠ wall in the
      mask), bold/filled furniture, hob + sink + R/F fridge symbols,
      TOTAL AREA captions — the RoomSketcher-style features that broke v1.
      Measured v1 on v2-style plans: door IoU drops 0.925→0.716 → retrain:
      re-run ml/colab_train.ipynb on this branch, upload best.pt +
      stride-planseg.onnx as a `model-v2` release, update MODEL_URL in
      scripts/fetch-model.mjs
- [x] Fixed a native memory leak in the generator: `@resvg/resvg-js` leaks
      ~2.7MB per `Resvg` instantiation, unbounded, regardless of font
      options — confirmed by measurement (15GB+ RSS by sample 5500, this
      sandbox's own OOM killer stopped it). This is exactly what silently
      truncated a Colab run at sample 2697/10000: Colab's `!shell` cells
      don't halt "Run all" on a non-zero exit, so training proceeded on an
      incomplete dataset until it hit the hole. Fixed in generate.mjs: large
      counts now run as a driver that restarts itself in a fresh subprocess
      every 400 samples (`--chunk`, byte-identical output either way — see
      the determinism check in git history) and verifies the exact file
      count on exit, non-zero otherwise. The Colab notebook's generation
      cell now uses `subprocess.run(check=True)` instead of raw `!` shell
      magics so a failure actually stops the run, plus an explicit image-
      count assert. Also dropped `Bitstream Charter` from the font list (no
      TTF/OTF on this system, only legacy Type1 — resvg can't parse it).
- [x] Retrained on v2 data (Colab T4, 10k samples, 30 epochs) → `model-v2`
      release, now what scripts/fetch-model.mjs pulls. Head-to-head on the
      hard held-out style (open-plan/balcony/bold furniture, unseen seed):
      door IoU v1 0.690 → v2 0.923 (wall 0.955→0.968, window 0.947→0.953),
      with no regression on the old style (v2 matches v1 within noise).
      Also added a glazing-edge filter to both vectorizers: v2 learned from
      sliding doors to fringe window ends with small door-class patches, so
      door components whose surroundings are substantially window-class get
      dropped (30 spurious doors → 7 real ones on the OOD apartment test,
      and the door-width scale fallback recovered from 2× off to ~15% off).
- [ ] Speed: enable wasm threads (needs COOP/COEP headers) and/or WebGPU
- [ ] Harder synthetics (L-shapes, diagonal walls, stairs, blueprint style,
      keystone warp) / real-data flywheel
