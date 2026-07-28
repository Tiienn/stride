# Train the floor-plan segmentation model.
#
#   python ml/train/train.py --data ml/data/train --epochs 30 --batch 8
#
# On an RTX 3060/4070-class GPU with 10-20k synthetic samples this reaches
# ~0.9 wall IoU in a few hours. CPU works for smoke tests only.
#
# last.pt is a full training-state checkpoint (model + optimizer + scheduler
# + epoch + best mIoU) saved every epoch; --auto-resume picks it up so an
# interrupted run continues exactly where it stopped. best.pt stays a bare
# model state_dict — inference/export code loads it unchanged.
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


def evaluate(model, val_dl, device):
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
    return miou, per_class


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
    ap.add_argument("--resume", default="", help="checkpoint to resume from")
    ap.add_argument("--auto-resume", action="store_true", help="resume from <out>/last.pt if it exists")
    ap.add_argument("--assume-epoch", type=int, default=0,
                    help="epochs already completed, used only when the resume checkpoint is a bare state_dict")
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

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    resume_path = args.resume
    if not resume_path and args.auto_resume and (out / "last.pt").exists():
        resume_path = str(out / "last.pt")

    criterion = nn.CrossEntropyLoss(weight=torch.tensor(CLASS_WEIGHTS, device=device))
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    scaler = torch.amp.GradScaler(enabled=device == "cuda")

    start_epoch = 0
    best_miou = 0.0
    if resume_path:
        ck = torch.load(resume_path, map_location=device)
        if isinstance(ck, dict) and "model" in ck:
            model.load_state_dict(ck["model"])
            opt.load_state_dict(ck["opt"])
            sched.load_state_dict(ck["sched"])
            if ck.get("scaler") and scaler.is_enabled():
                scaler.load_state_dict(ck["scaler"])
            start_epoch = ck["epoch"]
            best_miou = ck["best_miou"]
        else:
            # bare model state_dict (a legacy last.pt): weights only. Fast-
            # forward the LR schedule to --assume-epoch, and establish the
            # best-mIoU bar with a validation pass so a resumed epoch can't
            # overwrite best.pt with something worse.
            model.load_state_dict(ck)
            start_epoch = args.assume_epoch
            for _ in range(start_epoch):
                sched.step()
            best_miou, _ = evaluate(model, val_dl, device)
            print(f"legacy checkpoint: baseline val mIoU {best_miou:.3f}")
        if start_epoch >= args.epochs:
            print(f"nothing to do: {start_epoch}/{args.epochs} epochs already completed")
            return
        print(f"resumed from {resume_path} at epoch {start_epoch}/{args.epochs}, "
              f"best mIoU {best_miou:.3f}, lr {opt.param_groups[0]['lr']:.2e}")

    step = 0
    for epoch in range(start_epoch, args.epochs):
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

        miou, per_class = evaluate(model, val_dl, device)
        report = "  ".join(f"{n}:{v:.3f}" for n, v in zip(CLASS_NAMES, per_class))
        print(f"epoch {epoch}  loss {running / len(train_dl):.4f}  val IoU [{report}]  mIoU(no-bg) {miou:.3f}  {time.time() - t0:.0f}s")

        if miou > best_miou:
            best_miou = miou
            torch.save(model.state_dict(), out / "best.pt")
            print(f"  ↑ new best ({miou:.3f}) saved")
        torch.save({
            "model": model.state_dict(),
            "opt": opt.state_dict(),
            "sched": sched.state_dict(),
            "scaler": scaler.state_dict() if scaler.is_enabled() else None,
            "epoch": epoch + 1,
            "best_miou": best_miou,
        }, out / "last.pt")


if __name__ == "__main__":
    main()
