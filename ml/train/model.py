# Compact U-Net for floor-plan segmentation (~8M params). GroupNorm instead of
# BatchNorm so small batches (consumer GPUs, CPU smoke tests) train stably.
import torch
import torch.nn as nn
import torch.nn.functional as F


def conv_block(cin, cout):
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=1, bias=False),
        nn.GroupNorm(min(8, cout), cout),
        nn.SiLU(inplace=True),
        nn.Conv2d(cout, cout, 3, padding=1, bias=False),
        nn.GroupNorm(min(8, cout), cout),
        nn.SiLU(inplace=True),
    )


class UNet(nn.Module):
    def __init__(self, num_classes=4, base=32):
        super().__init__()
        c = [base, base * 2, base * 4, base * 8]
        self.enc1 = conv_block(3, c[0])
        self.enc2 = conv_block(c[0], c[1])
        self.enc3 = conv_block(c[1], c[2])
        self.enc4 = conv_block(c[2], c[3])
        self.bottleneck = conv_block(c[3], c[3] * 2)
        self.up4 = nn.ConvTranspose2d(c[3] * 2, c[3], 2, stride=2)
        self.dec4 = conv_block(c[3] * 2, c[3])
        self.up3 = nn.ConvTranspose2d(c[3], c[2], 2, stride=2)
        self.dec3 = conv_block(c[2] * 2, c[2])
        self.up2 = nn.ConvTranspose2d(c[2], c[1], 2, stride=2)
        self.dec2 = conv_block(c[1] * 2, c[1])
        self.up1 = nn.ConvTranspose2d(c[1], c[0], 2, stride=2)
        self.dec1 = conv_block(c[0] * 2, c[0])
        self.head = nn.Conv2d(c[0], num_classes, 1)

    def forward(self, x):
        e1 = self.enc1(x)
        e2 = self.enc2(F.max_pool2d(e1, 2))
        e3 = self.enc3(F.max_pool2d(e2, 2))
        e4 = self.enc4(F.max_pool2d(e3, 2))
        b = self.bottleneck(F.max_pool2d(e4, 2))
        d4 = self.dec4(torch.cat([self.up4(b), e4], 1))
        d3 = self.dec3(torch.cat([self.up3(d4), e3], 1))
        d2 = self.dec2(torch.cat([self.up2(d3), e2], 1))
        d1 = self.dec1(torch.cat([self.up1(d2), e1], 1))
        return self.head(d1)
