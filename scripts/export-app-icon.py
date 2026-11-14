"""Cut out the supplied original icon without changing its RGB pixels."""
from pathlib import Path
from statistics import median
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'output/branding/orbit-dark-planet-source.png'
original = Image.open(source).convert('RGB')

# Trace the rim on each row and keep every pixel between its two sides.
# The original is retained as RGB; only exterior transparency is changed.
luminance = original.convert('L')
alpha = Image.new('L', original.size, 0)
draw = ImageDraw.Draw(alpha)
edges = {}
for y in range(90, 1165):
    row = [x for x in range(80, 1175) if luminance.getpixel((x, y)) > 20]
    if row:
        edges[y] = (row[0], row[-1])
for y, (left, right) in edges.items():
    neighbors = [edges[yy] for yy in range(y - 2, y + 3) if yy in edges]
    left = round(median(pair[0] for pair in neighbors))
    right = round(median(pair[1] for pair in neighbors))
    draw.line((left, y, right, y), fill=255)
# Only the alpha mask is softened; the source image's colors remain intact.
alpha = alpha.filter(ImageFilter.GaussianBlur(0.7))
icon = original.convert('RGBA')
icon.putalpha(alpha)
assert icon.getpixel((0, 0))[3] == 0
assert icon.getpixel((original.width // 2, original.height // 2))[3] == 255
assert icon.getpixel((200, 600))[3] == 255
assert icon.convert('RGB').tobytes() == original.tobytes()
assert all(icon.getpixel((x, y))[3] == 255
           for y in range(150, 1100, 25) for x in range(300, 950, 25))

icon.save(ROOT / 'output/branding/orbit-original-cutout-refined.png')
for destination, size in [
    ('desktop/icons/orbit.png', 512),
    ('public/icons/orbit-192.png', 192),
    ('public/icons/orbit-32.png', 32),
]:
    icon.resize((size, size), Image.Resampling.LANCZOS).save(ROOT / destination)
icon.save(ROOT / 'desktop/icons/orbit.ico', sizes=[
    (16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256),
])

# A light background makes the actual cutout boundary easy to inspect.
preview = Image.new('RGBA', icon.size, '#e7e8ec')
preview.alpha_composite(icon)
preview.resize((512, 512), Image.Resampling.LANCZOS).convert('RGB').save(
    ROOT / 'output/branding/orbit-original-cutout-refined-preview.png')
print('Original RGB preserved byte-for-byte; exterior removed; PNG and ICO exported.')
