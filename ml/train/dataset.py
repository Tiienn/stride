# Dataset for floor-plan segmentation: pairs img_NNNNN.png / msk_NNNNN.png
# produced by ml/generate.mjs. Mask colors: black=bg, red=wall, green=door,
# blue=window -> class ids 0..3.
#
# Augmentation philosophy: the generator already randomizes drawing STYLE;
# this loader randomizes CAPTURE conditions — scale, crops, blur, noise,
# JPEG artifacts, contrast — so the model survives phone photos and old scans.
import io
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageEnhance, ImageFilter
from torch.utils.data import Dataset

NUM_CLASSES = 4  # bg, wall, door, window


def mask_to_classes(mask_rgb: np.ndarray) -> np.ndarray:
    r, g, b = mask_rgb[..., 0], mask_rgb[..., 1], mask_rgb[..., 2]
    out = np.zeros(mask_rgb.shape[:2], dtype=np.int64)
    out[(r > 127) & (g < 128)] = 1  # wall
    out[(g > 127) & (r < 128)] = 2  # door
    out[(b > 127) & (r < 128) & (g < 128)] = 3  # window
    return out


class FloorplanDataset(Dataset):
    def __init__(self, root, size=512, train=True):
        self.root = Path(root)
        self.size = size
        self.train = train
        self.images = sorted(self.root.glob("img_*.png"))
        if not self.images:
            raise FileNotFoundError(f"no img_*.png under {root} — run ml/generate.mjs first")

    def __len__(self):
        return len(self.images)

    def __getitem__(self, idx):
        img_path = self.images[idx]
        msk_path = img_path.with_name(img_path.name.replace("img_", "msk_"))
        img = Image.open(img_path).convert("RGB")
        msk = Image.open(msk_path).convert("RGB")

        if self.train:
            img, msk = self._geometric(img, msk)
            img = self._photometric(img)
        else:
            img, msk = self._resize_pad(img, msk)

        x = torch.from_numpy(np.asarray(img, dtype=np.float32).transpose(2, 0, 1) / 255.0)
        y = torch.from_numpy(mask_to_classes(np.asarray(msk)))
        return x, y

    # random scale + crop to a square window, flips and 90° rotations
    def _geometric(self, img, msk):
        s = self.size
        scale = random.uniform(0.65, 1.25)
        w, h = img.size
        nw, nh = max(s, int(w * scale)), max(s, int(h * scale))
        img = img.resize((nw, nh), Image.BILINEAR)
        msk = msk.resize((nw, nh), Image.NEAREST)
        x0 = random.randint(0, nw - s)
        y0 = random.randint(0, nh - s)
        img = img.crop((x0, y0, x0 + s, y0 + s))
        msk = msk.crop((x0, y0, x0 + s, y0 + s))
        a_img, a_msk = np.asarray(img), np.asarray(msk)
        if random.random() < 0.5:
            a_img, a_msk = a_img[:, ::-1], a_msk[:, ::-1]
        k = random.randint(0, 3)
        if k:
            a_img, a_msk = np.rot90(a_img, k), np.rot90(a_msk, k)
        return Image.fromarray(np.ascontiguousarray(a_img)), Image.fromarray(np.ascontiguousarray(a_msk))

    def _resize_pad(self, img, msk):
        s = self.size
        w, h = img.size
        f = min(s / w, s / h)
        nw, nh = int(w * f), int(h * f)
        img = img.resize((nw, nh), Image.BILINEAR)
        msk = msk.resize((nw, nh), Image.NEAREST)
        ci = Image.new("RGB", (s, s), (255, 255, 255))
        cm = Image.new("RGB", (s, s), (0, 0, 0))
        ci.paste(img, (0, 0))
        cm.paste(msk, (0, 0))
        return ci, cm

    # capture-condition degradations (image only — labels are geometry)
    def _photometric(self, img):
        if random.random() < 0.3:
            img = img.convert("L").convert("RGB")
        if random.random() < 0.5:
            img = ImageEnhance.Brightness(img).enhance(random.uniform(0.75, 1.2))
        if random.random() < 0.5:
            img = ImageEnhance.Contrast(img).enhance(random.uniform(0.7, 1.3))
        if random.random() < 0.35:
            img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.4, 1.3)))
        if random.random() < 0.4:  # JPEG artifacts — the #1 real-world degradation
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=random.randint(35, 90))
            buf.seek(0)
            img = Image.open(buf).convert("RGB")
        if random.random() < 0.35:  # sensor/scan noise
            a = np.asarray(img, dtype=np.float32)
            a += np.random.normal(0, random.uniform(2, 10), a.shape)
            img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        return img
