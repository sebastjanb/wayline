"""Draws the app icon (white navigation arrow on a purple-to-blue tile) and wires
it into the page the way Meta's own packaging script does for display glasses:
one RGBA favicon.png at the site root, one <link rel="icon"> carrying the same
image inline, and one manifest entry. Pure standard library."""
import base64, re, struct, zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'site'


def in_arrow(u, v):
    y = v + 0.03
    if y < -0.30 or y > 0.27 or abs(u) > (y + 0.30) * 0.50:
        return False
    return not (y > 0.11 and abs(u) < (y - 0.11) * 1.75)


def png(size, samples=4):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = 0.0
            for sy in range(samples):
                for sx in range(samples):
                    u = (px + (sx + .5) / samples) / size - .5
                    v = (py + (sy + .5) / samples) / size - .5
                    # Full-bleed tile: the launcher applies its own mask, and a
                    # transparent (black) corner would vanish on the display.
                    if in_arrow(u, v):
                        c = (255, 255, 255)
                    else:
                        t = min(1, max(0, (u + v + 1) / 2))
                        c = (148 - 87 * t, 97 + 58 * t, 255)
                    r += c[0]; g += c[1]; b += c[2]
            k = samples * samples
            row += bytes((int(r / k), int(g / k), int(b / k), 255))
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)   # 8-bit RGBA
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')


def monochrome(size, samples=4):
    """White arrow on a transparent background. The glasses tint this artwork
    and draw their own themed tile behind it (Meta Wearables app manifest)."""
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            hits = 0
            for sy in range(samples):
                for sx in range(samples):
                    # Shrunk to 80% so the artwork keeps clear space around it.
                    u = ((px + (sx + .5) / samples) / size - .5) / 0.8
                    v = ((py + (sy + .5) / samples) / size - .5) / 0.8
                    hits += in_arrow(u, v)
            row += bytes((255, 255, 255, round(255 * hits / (samples * samples))))
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')


(OUT / 'icons' / 'glasses-icon.png').write_bytes(monochrome(256))

FAVICON_SIZE = 128   # must be larger than 52x52

for size in (192, 512):
    (OUT / 'icons' / f'icon-{size}.png').write_bytes(png(size, 3 if size == 512 else 4))

favicon = png(FAVICON_SIZE)
(OUT / 'favicon.png').write_bytes(favicon)

# The page carries the icon inline, so the glasses need no second request for it.
index = OUT / 'index.html'
html = index.read_text()
html = re.sub(r'<link\b[^>]*\brel="[^"]*icon[^"]*"[^>]*>\n?', '', html)
link = f'<link rel="icon" type="image/png" href="data:image/png;base64,{base64.b64encode(favicon).decode()}">\n'
html = html.replace('<link rel="manifest"', link + '<link rel="manifest"', 1)
index.write_text(html)
print('icons written')
