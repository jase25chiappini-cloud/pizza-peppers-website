from PIL import Image
import numpy as np

SRC = "src/assets/pizza-peppers-banner.png"
OUT = "src/assets/pizza-peppers-banner-cropped.png"

im = Image.open(SRC).convert("RGBA")
arr = np.array(im)

# treat "real content" as pixels that aren't basically black
rgb = arr[:, :, :3]
a = arr[:, :, 3]
mask = (a > 10) & (rgb.max(axis=2) > 30)

ys, xs = np.where(mask)
y0, y1 = ys.min(), ys.max()
x0, x1 = xs.min(), xs.max()

# add a little padding
pad = 10
y0 = max(0, y0 - pad)
y1 = min(arr.shape[0] - 1, y1 + pad)
x0 = max(0, x0 - pad)
x1 = min(arr.shape[1] - 1, x1 + pad)

cropped = im.crop((x0, y0, x1 + 1, y1 + 1))
cropped.save(OUT)

print("Wrote:", OUT, "size:", cropped.size)
