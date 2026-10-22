"""產生 baguette 的程式圖示（法國麵包）：build/icon.ico。

畫法跟 sausage 的 scripts/make_icon.py 同一套（沿二次貝茲曲線蓋圓章組出
形體，再疊暗面、亮面、反光條），兩個專案的圖示才會像同一個系列。

需要 Pillow（pip install pillow）。在 repo 根目錄執行：
    python scripts/make_icon.py
加 --preview 會另存 build/icon-preview.png（README 用的那張）。
"""
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops

N = 1024
W = 1400

def bez(t, p0, p1, p2):
    a = (1 - t) ** 2; b = 2 * (1 - t) * t; c = t * t
    return (a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1])

# 比香腸更長、更直：法棍幾乎是一條斜線，只帶一點弧度
P0, P1, P2 = (250, 1080), (640, 760), (1150, 330)
R = 165

def radius(t):
    # 中段粗、兩端收尖但保留圓頭（法棍的頭不是針尖）
    return R * (0.30 + 0.70 * math.sin(math.pi * t) ** 0.55)

def stamp(draw, extra, fill, offset=(0, 0), scale=1.0, t0=0.0, t1=1.0):
    steps = 500
    for i in range(steps + 1):
        t = t0 + (t1 - t0) * i / steps
        x, y = bez(t, P0, P1, P2)
        r = radius(t) * scale + extra
        x += offset[0]; y += offset[1]
        draw.ellipse((x - r, y - r, x + r, y + r), fill=fill)

def mask(extra=0, offset=(0, 0), scale=1.0):
    m = Image.new("L", (W, W), 0)
    stamp(ImageDraw.Draw(m), extra, 255, offset, scale)
    return m

def frame(t):
    """曲線在 t 處的位置、切線、法線。"""
    x, y = bez(t, P0, P1, P2)
    x2, y2 = bez(min(t + 0.01, 1.0), P0, P1, P2)
    dx, dy = x2 - x, y2 - y
    L = math.hypot(dx, dy); dx /= L; dy /= L
    return x, y, dx, dy, -dy, dx

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))

# 陰影
shadow = mask(10, (18, 30)).filter(ImageFilter.GaussianBlur(22))
img.paste(Image.new("RGBA", (W, W), (45, 25, 8, 110)), (0, 0), shadow)

# 外框 + 麵包本體
img.paste(Image.new("RGBA", (W, W), (92, 50, 16, 255)), (0, 0), mask(28))
body = mask(0)
img.paste(Image.new("RGBA", (W, W), (212, 146, 60, 255)), (0, 0), body)

# 暗面（右下）
dark = ImageChops.multiply(mask(0, (36, 48), 0.95).point(lambda v: 255 - v), body).filter(ImageFilter.GaussianBlur(24))
img.paste(Image.new("RGBA", (W, W), (160, 94, 30, 255)), (0, 0), ImageChops.multiply(dark, body))

# 亮面（左上）與反光條
light = ImageChops.multiply(mask(0, (-26, -36), 0.6), body).filter(ImageFilter.GaussianBlur(28))
img.paste(Image.new("RGBA", (W, W), (238, 186, 98, 255)), (0, 0), ImageChops.multiply(light, body))
glint = Image.new("L", (W, W), 0)
stamp(ImageDraw.Draw(glint), 0, 255, (-50, -62), 0.13, 0.14, 0.8)
glint = glint.filter(ImageFilter.GaussianBlur(7))
img.paste(Image.new("RGBA", (W, W), (255, 238, 205, 255)), (0, 0), ImageChops.multiply(glint, body).point(lambda v: int(v * 0.7)))

# 表面的割紋：每道先畫一條深色的唇（割口下緣的陰影），再在上面畫爆開的
# 淺色麵包芯。法棍的割紋幾乎順著軸線、只斜一點，前後道彼此錯開重疊，
# 這是它跟其他長麵包最好分的特徵；畫成橫的會像貼紙。
lip = Image.new("L", (W, W), 0)
crumb = Image.new("L", (W, W), 0)
ld, cd = ImageDraw.Draw(lip), ImageDraw.Draw(crumb)
ang = math.radians(16)
for t in (0.24, 0.42, 0.60, 0.78):
    x, y, dx, dy, nx, ny = frame(t)
    # 割紋方向：切線往法線轉 ang
    ux = dx * math.cos(ang) + nx * math.sin(ang)
    uy = dy * math.cos(ang) + ny * math.sin(ang)
    half = 125
    a = (x - ux * half, y - uy * half)
    b = (x + ux * half, y + uy * half)
    ld.line([(a[0] + 8, a[1] + 12), (b[0] + 8, b[1] + 12)], fill=255, width=46)
    cd.line([a, b], fill=255, width=32)
    for p in (a, b):  # 圓頭
        ld.ellipse((p[0] + 8 - 23, p[1] + 12 - 23, p[0] + 8 + 23, p[1] + 12 + 23), fill=255)
        cd.ellipse((p[0] - 16, p[1] - 16, p[0] + 16, p[1] + 16), fill=255)
inner = mask(-14)
lip = ImageChops.multiply(lip.filter(ImageFilter.GaussianBlur(3)), inner)
crumb = ImageChops.multiply(crumb.filter(ImageFilter.GaussianBlur(2)), inner)
img.paste(Image.new("RGBA", (W, W), (128, 72, 20, 255)), (0, 0), lip.point(lambda v: int(v * 0.85)))
img.paste(Image.new("RGBA", (W, W), (248, 224, 168, 255)), (0, 0), crumb)

# 裁掉空白、置中成正方形（留 3% 邊）
box = img.getbbox()
w, h = box[2] - box[0], box[3] - box[1]
side = int(max(w, h) * 1.06)
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.alpha_composite(img.crop(box), ((side - w) // 2, (side - h) // 2))
icon = sq.resize((N, N), Image.LANCZOS)
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
out = os.path.normpath(os.path.join(root, "build", "icon.ico"))
icon.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("已產生", out)
if "--preview" in sys.argv:
    p = os.path.normpath(os.path.join(root, "build", "icon-preview.png"))
    icon.resize((512, 512), Image.LANCZOS).save(p)
    print("預覽", p)
