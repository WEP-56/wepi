"""测量 logo.png 的字形边界与填充率，并输出紧凑裁剪版（去多余透明边距）。

填充率不足 ~88% 的图标在系统托盘 / 任务栏里会显得明显偏小——Windows 把
ico 的 32px 与托盘的 16px 区域按「含透明边距的整个画布」缩放，logo 四周
留白越多，可见字形越小。紧凑裁剪（留 4% 安全边）后再生成图标即可恢复
视觉尺寸。
"""
from PIL import Image

SRC = r"E:\WEPI\docs\logo.png"
OUT = r"E:\WEPI\src\assets-icon-base.png"

img = Image.open(SRC).convert("RGBA")
W, H = img.size
bbox = img.getbbox()  # 非全透明区域的边界 (left, upper, right, lower)
print(f"canvas {W}x{H}, glyph bbox {bbox}")
if bbox:
    gw = bbox[2] - bbox[0]
    gh = bbox[3] - bbox[1]
    print(f"fill: {100 * gw / W:.1f}% x {100 * gh / H:.1f}%")

    # 留 4% 安全边（贴合边界会导致小尺寸抗锯齿裁切）。
    pad_x = round(W * 0.04)
    pad_y = round(H * 0.04)
    left = max(0, bbox[0] - pad_x)
    upper = max(0, bbox[1] - pad_y)
    right = min(W, bbox[2] + pad_x)
    lower = min(H, bbox[3] + pad_y)
    cropped = img.crop((left, upper, right, lower))
    cw, ch = cropped.size
    print(f"cropped canvas {cw}x{ch} -> new fill {100 * (bbox[2]-bbox[0]) / cw:.1f}% x {100 * (bbox[3]-bbox[1]) / ch:.1f}%")
    cropped.save(OUT)
    print(f"saved {OUT}")
