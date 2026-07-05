# Train the floor-plan segmentation model.
#
#   python ml/train/train.py --data ml/data/train --epochs 30 --batch 8
#
# On an RTX 3060/4070-class GPU with 10-20k synthetic samples this reaches
# ~0.9 wall IoU in a few hours. CPU works for smoke tests only.
import argparse
import time
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import DataLoader, random_split

from dataset import NUM_CLASSES, FloorplanDataset
from model import UNet

# background dominates the pixels; doors/windows are rare and matter most
CLASS_WEIGHTS = [0.25, 1.0, 3.0, 3.0]
CLASS_NAMES = ["bg", "wall", "door", "window"]


def iou_per_class(pred, target, num_classes):
    ious = []
    for c in range(num_classes):
        p, t = pred == c, target == c
        inter = (p & t).sum().item()
        union = (p | t).sum().item()
        ious.append(inter / union if union else float("nan"))
    return ious


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/train")
    ap.add_argument("--out", default="ml/checkpoints")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--base", type=int, default=32, help="UNet width")
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--max-steps", type=int, default=0, help="smoke test: stop after N steps")
    ap.add_argument("--resume", default="")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"device: {device}")

    full = FloorplanDataset(args.data, size=args.size, train=True)
    n_val = max(1, int(len(full) * args.val_frac))
    train_ds, val_ds = random_split(full, [len(full) - n_val, n_val], generator=torch.Generator().manual_seed(0))
    # validation uses deterministic resize (no crops/noise)
    val_ds.dataset = FloorplanDataset(args.data, size=args.size, train=False)
    print(f"train {len(train_ds)}  val {len(val_ds)}")

    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers, pin_memory=device == "cuda")
    val_dl = DataLoader(val_ds, batch_size=args.batch, num_workers=args.workers)

    model = UNet(NUM_CLASSES, base=args.base).to(device)
    print(f"params: {sum(p.numel() for p in model.parameters()) / 1e6:.1f}M")
    if args.resume:
        model.load_state_dict(torch.load(args.resume, map_location=device))

    criterion = nn.CrossEntropyLoss(weight=torch.tensor(CLASS_WEIGHTS, device=device))
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    scaler = torch.amp.GradScaler(enabled=device == "cuda")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    best_miou = 0.0
    step = 0

    for epoch in range(args.epochs):
        model.train()
        t0, running = time.time(), 0.0
        for i, (x, y) in enumerate(train_dl):
            x, y = x.to(device), y.to(device)
            opt.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device if device != "mps" else "cpu", enabled=device == "cuda"):
                loss = criterion(model(x), y)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            running += loss.item()
            step += 1
            if i % 20 == 0:
                print(f"e{epoch} s{i}/{len(train_dl)} loss {running / (i + 1):.4f}")
            if args.max_steps and step >= args.max_steps:
                print("max-steps reached (smoke test) — saving and exiting")
                torch.save(model.state_dict(), out / "last.pt")
                return
        sched.step()

        model.eval()
        ious = torch.zeros(NUM_CLASSES)
        counts = torch.zeros(NUM_CLASSES)
        with torch.no_grad():
            for x, y in val_dl:
                x, y = x.to(device), y.to(device)
                pred = model(x).argmax(1)
                for c, v in enumerate(iou_per_class(pred, y, NUM_CLASSES)):
                    if v == v:  # not nan
                        ious[c] += v
                        counts[c] += 1
        per_class = (ious / counts.clamp(min=1)).tolist()
        miou = sum(per_class[1:]) / (NUM_CLASSES - 1)  # ignore bg
        report = "  ".join(f"{n}:{v:.3f}" for n, v in zip(CLASS_NAMES, per_class))
        print(f"epoch {epoch}  loss {running / len(train_dl):.4f}  val IoU [{report}]  mIoU(no-bg) {miou:.3f}  {time.time() - t0:.0f}s")

        torch.save(model.state_dict(), out / "last.pt")
        if miou > best_miou:
            best_miou = miou
            torch.save(model.state_dict(), out / "best.pt")
            print(f"  ↑ new best ({miou:.3f}) saved")


if __name__ == "__main__":
    main()
