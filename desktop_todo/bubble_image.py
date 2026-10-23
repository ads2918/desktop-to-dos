"""Draw the floating bubble: a round icon with the emoji, a background, and the unfinished-task count."""

import base64
import binascii
import colorsys
import io
import logging
import math
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from desktop_todo import emoji_icon

log = logging.getLogger(__name__)

# Everything is drawn this many times larger and then shrunk, which smooths the circle's edge.
SUPERSAMPLE = 4
BADGE_FONT_PATH = r"C:\Windows\Fonts\segoeuib.ttf"
BADGE_RED = (229, 56, 79, 255)
# The page sends a 256 px PNG when the bubble opens and 128 px JPEG frames while it animates.
SNAPSHOT_DATA_URL_PREFIXES = {"data:image/png;base64,": "PNG", "data:image/jpeg;base64,": "JPEG"}
# Both are well under 1 MB; anything far bigger isn't ours, so ignore it.
MAX_SNAPSHOT_DATA_URL_LENGTH = 4_000_000
MAX_SNAPSHOT_SIDE = 1024


def get_shadow_margin(diameter):
    """Room around the circle for its soft drop shadow."""
    return max(4, round(diameter * 0.1))


def render_rainbow_disc(size):
    """Used when no icon colour is picked: a tie-dye-like colour wheel, lighter towards the middle."""
    disc = Image.new("RGBA", (size, size))
    pixels = disc.load()
    centre = (size - 1) / 2
    for y in range(size):
        for x in range(size):
            hue = (math.atan2(y - centre, x - centre) / (2 * math.pi)) % 1
            distance = min(1, math.hypot(x - centre, y - centre) / centre)
            r, g, b = colorsys.hsv_to_rgb(hue, 0.35 + 0.55 * distance, 1)
            pixels[x, y] = (round(r * 255), round(g * 255), round(b * 255), 255)
    return disc


def decode_background_snapshot(data_url):
    """The page's snapshot of its background (a PNG or JPEG data URL) as an RGBA image, or None if
    it's missing or not a sensible image, in which case the bubble falls back to a colour."""
    if not isinstance(data_url, str):
        return None
    prefix = next((prefix for prefix in SNAPSHOT_DATA_URL_PREFIXES if data_url.startswith(prefix)), None)
    if prefix is None:
        return None
    if len(data_url) > MAX_SNAPSHOT_DATA_URL_LENGTH:
        log.warning("Background snapshot is %d characters, too big to be ours; using a plain colour instead.",
                    len(data_url))
        return None
    try:
        image = Image.open(io.BytesIO(base64.b64decode(data_url[len(prefix):], validate=True)))
        if image.format != SNAPSHOT_DATA_URL_PREFIXES[prefix] or max(image.size) > MAX_SNAPSHOT_SIDE:
            log.warning("Background snapshot is not a %s up to %d px (%s %s); using a plain colour instead.",
                        SNAPSHOT_DATA_URL_PREFIXES[prefix], MAX_SNAPSHOT_SIDE, image.format, image.size)
            return None
        return image.convert("RGBA")
    except (binascii.Error, OSError, ValueError) as error:
        log.warning("Could not read the background snapshot (%s); using a plain colour instead.", error)
        return None


def draw_count_badge(image, count, diameter_big, offset):
    """A red pill with the count, bottom-centre so the circle's edge never cuts it off."""
    text = str(count) if count < 100 else "99+"
    font = ImageFont.truetype(BADGE_FONT_PATH, round(diameter_big * 0.17))
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    height = round(diameter_big * 0.27)
    width = max(height, right - left + height * 0.7)
    centre_x = offset + diameter_big / 2
    badge_bottom = offset + diameter_big - diameter_big * 0.04
    box = [centre_x - width / 2, badge_bottom - height, centre_x + width / 2, badge_bottom]
    draw.rounded_rectangle(box, radius=height / 2, fill=BADGE_RED, outline=(255, 255, 255, 230),
                           width=max(1, SUPERSAMPLE))
    draw.text((centre_x, badge_bottom - height / 2), text, font=font, fill="white", anchor="mm")


@dataclass(frozen=True)
class BubbleLayers:
    """The parts of the bubble that don't change between animation frames, at final size."""
    shadow: Image.Image          # whole bubble image size, just the drop shadow
    circle_mask: Image.Image     # diameter x diameter, antialiased circle
    overlay: Image.Image         # whole bubble image size: rim, emoji and badge over transparency
    margin: int
    diameter: int


def render_bubble_layers(emoji, unfinished_count, diameter):
    """Draw the fixed parts once (supersampled for smooth edges); frames then only swap the fill."""
    margin = get_shadow_margin(diameter)
    size = diameter + 2 * margin
    size_big = size * SUPERSAMPLE
    diameter_big = diameter * SUPERSAMPLE
    offset = margin * SUPERSAMPLE
    circle_box = [offset, offset, offset + diameter_big - 1, offset + diameter_big - 1]

    shadow = Image.new("RGBA", (size_big, size_big), (0, 0, 0, 0))
    shadow_box = [coordinate + (SUPERSAMPLE * 2 if index % 2 else 0) for index, coordinate in enumerate(circle_box)]
    ImageDraw.Draw(shadow).ellipse(shadow_box, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(margin * SUPERSAMPLE / 2.5))

    circle_mask = Image.new("L", (diameter_big, diameter_big), 0)
    ImageDraw.Draw(circle_mask).ellipse([0, 0, diameter_big - 1, diameter_big - 1], fill=255)

    overlay = Image.new("RGBA", (size_big, size_big), (0, 0, 0, 0))
    ImageDraw.Draw(overlay).ellipse(circle_box, outline=(255, 255, 255, 150), width=round(diameter_big * 0.04))
    emoji_size = round(diameter_big * 0.56)
    emoji_image = emoji_icon.render_emoji_to_image(emoji or "📝", emoji_size)
    emoji_top = offset + round(diameter_big * (0.42 if unfinished_count else 0.5)) - emoji_size // 2
    overlay.alpha_composite(emoji_image, (offset + (diameter_big - emoji_size) // 2, emoji_top))
    if unfinished_count:
        draw_count_badge(overlay, unfinished_count, diameter_big, offset)

    return BubbleLayers(
        shadow=shadow.resize((size, size), Image.LANCZOS),
        circle_mask=circle_mask.resize((diameter, diameter), Image.LANCZOS),
        overlay=overlay.resize((size, size), Image.LANCZOS),
        margin=margin,
        diameter=diameter,
    )


def compose_bubble_frame(layers, fill):
    """One frame: the shadow, the fill clipped to the circle, then rim/emoji/badge on top."""
    frame = layers.shadow.copy()
    frame.paste(fill.resize((layers.diameter, layers.diameter), Image.BILINEAR), (layers.margin, layers.margin),
                layers.circle_mask)
    frame.alpha_composite(layers.overlay)
    return frame


def choose_bubble_fill(diameter, background_snapshot=None, background_colour=None):
    """The snapshot of the window's background when there is one (so the bubble matches the tie-dye /
    ocean / etc. the window shows), else the icon colour, else a rainbow."""
    if background_snapshot is not None:
        return background_snapshot
    rgb = emoji_icon.parse_hex_colour(background_colour)
    return emoji_icon.render_shaded_square(diameter, rgb) if rgb else render_rainbow_disc(diameter)


def render_bubble_image(emoji, unfinished_count, diameter, background_snapshot=None, background_colour=None):
    """RGBA image of the bubble, `diameter` px across plus a shadow margin on every side."""
    layers = render_bubble_layers(emoji, unfinished_count, diameter)
    return compose_bubble_frame(layers, choose_bubble_fill(diameter, background_snapshot, background_colour))
