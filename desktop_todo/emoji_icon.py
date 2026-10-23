"""Turn an emoji into a Windows .ico and put it on the app window and taskbar button."""

import ctypes
import logging
import sys
from ctypes import wintypes
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, features

log = logging.getLogger(__name__)

EMOJI_FONT_PATH = Path(r"C:\Windows\Fonts\seguiemj.ttf")
# Includes the 125%/150% display sizes (20, 40, 72, 96) so Windows picks an exact match rather
# than resampling a neighbour.
ICON_SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (72, 72), (96, 96),
              (128, 128), (256, 256)]
MAX_EMOJI_LENGTH = 16
# Segoe UI Emoji is vector (COLR), so it can be drawn at any size; 300pt gives ~297 px of ink.
EMOJI_DRAW_SIZE = 300

ZERO_WIDTH_JOINER = "\u200d"
VARIATION_SELECTORS = "\ufe0e\ufe0f"


def prepare_emoji_for_basic_text_layout(emoji):
    """Trim an emoji to what Pillow can draw as one picture.

    Without the raqm layout library (not in the standard Pillow wheel on Windows), joined emoji like
    👨‍💻 come out as two pictures side by side, so only the part before the first joiner is kept.
    """
    if not features.check("raqm") and ZERO_WIDTH_JOINER in emoji:
        emoji = emoji.split(ZERO_WIDTH_JOINER)[0]
    return "".join(char for char in emoji if char not in VARIATION_SELECTORS)


def parse_hex_colour(colour):
    """'#ff3cac' → (255, 60, 172); anything else → None (no tile, just the emoji)."""
    if not isinstance(colour, str) or len(colour) != 7 or not colour.startswith("#"):
        return None
    try:
        return tuple(int(colour[i:i + 2], 16) for i in (1, 3, 5))
    except ValueError:
        return None


def render_shaded_square(size, rgb):
    """The colour, 25% lighter at the top fading to 15% darker at the bottom."""
    shade = Image.new("RGBA", (size, size))
    shade_draw = ImageDraw.Draw(shade)
    for y in range(size):
        amount = 0.25 - 0.4 * y / (size - 1)
        row = tuple(round(c + (255 - c) * amount) if amount > 0 else round(c * (1 + amount)) for c in rgb)
        shade_draw.line([(0, y), (size, y)], fill=row + (255,))
    return shade


def render_coloured_tile(size, rgb):
    """A rounded square with a soft top-to-bottom shade, like an app icon tile."""
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size // 5, fill=255)
    tile.paste(render_shaded_square(size, rgb), (0, 0), mask)
    return tile


def render_emoji_to_image(emoji, size=256, background=None):
    """Draw the emoji in colour, centred on a transparent square, or on a coloured tile when
    `background` is a '#rrggbb' colour."""
    if not isinstance(emoji, str) or not emoji.strip():
        raise ValueError("Pick an emoji first.")
    if len(emoji) > MAX_EMOJI_LENGTH:
        raise ValueError(f"That is {len(emoji)} characters; an icon needs a single emoji.")

    text = prepare_emoji_for_basic_text_layout(emoji.strip())
    # Draw bigger than the largest icon size and only ever shrink: at the old 109pt the emoji was
    # ~100 px and got stretched to 256, which looked blurry and pixelated on the desktop/taskbar.
    # The canvas is roomy so emoji with odd metrics aren't cut off before cropping to the ink.
    font = ImageFont.truetype(str(EMOJI_FONT_PATH), EMOJI_DRAW_SIZE)
    canvas = Image.new("RGBA", (EMOJI_DRAW_SIZE * 2, EMOJI_DRAW_SIZE * 2), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((EMOJI_DRAW_SIZE, EMOJI_DRAW_SIZE), text, font=font, anchor="mm", embedded_color=True)

    ink_box = canvas.getbbox()
    if ink_box is None:
        raise ValueError(f"The emoji font has no picture for {emoji!r}.")
    glyph = canvas.crop(ink_box)

    side = max(glyph.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2))

    rgb = parse_hex_colour(background)
    if rgb is None:
        return square.resize((size, size), Image.LANCZOS)
    # On a tile the emoji is shrunk to leave a margin, so the tile colour shows around it.
    emoji_size = round(size * 0.74)
    tile = render_coloured_tile(size, rgb)
    offset = (size - emoji_size) // 2
    tile.alpha_composite(square.resize((emoji_size, emoji_size), Image.LANCZOS), (offset, offset))
    return tile


def render_emoji_to_icon_file(emoji, icon_path, background=None):
    icon_path = Path(icon_path)
    icon_path.parent.mkdir(parents=True, exist_ok=True)
    render_emoji_to_image(emoji, background=background).save(icon_path, format="ICO", sizes=ICON_SIZES)
    return icon_path


def set_taskbar_identity_for_this_process(app_id="Revive.StickyToDo"):
    """Give the app its own taskbar identity; otherwise Windows shows the generic Python icon."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except (AttributeError, OSError) as error:
        log.warning("Could not set the taskbar app id (%s); the taskbar may show the Python icon.", error)


def apply_icon_file_to_window_handle(window_handle, icon_path):
    """Post WM_SETICON for the small (title bar) and big (taskbar, Alt+Tab) icons."""
    if sys.platform != "win32" or not window_handle:
        return False
    user32 = ctypes.windll.user32
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                                  ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    IMAGE_ICON, LR_LOADFROMFILE, WM_SETICON = 1, 0x10, 0x80
    ICON_SMALL, ICON_BIG = 0, 1
    # Load at the display's scaled sizes (e.g. 20 and 40 px at 125%); a fixed 16/32 got stretched
    # by Windows and looked soft on the taskbar.
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    scale = (user32.GetDpiForWindow(window_handle) or 96) / 96
    small_size, big_size = round(16 * scale), round(32 * scale)
    small_icon = user32.LoadImageW(None, str(icon_path), IMAGE_ICON, small_size, small_size, LR_LOADFROMFILE)
    big_icon = user32.LoadImageW(None, str(icon_path), IMAGE_ICON, big_size, big_size, LR_LOADFROMFILE)
    if not small_icon or not big_icon:
        log.warning("Windows could not load icon %s; keeping the current icon.", icon_path)
        return False
    # PostMessage, not SendMessage: this runs on a worker thread, and SendMessage would wait on the
    # window's UI thread, which can itself be waiting on us (that froze the app).
    user32.PostMessageW(window_handle, WM_SETICON, ICON_SMALL, small_icon)
    user32.PostMessageW(window_handle, WM_SETICON, ICON_BIG, big_icon)
    return True


def find_window_handle_by_title(title):
    if sys.platform != "win32":
        return None
    user32 = ctypes.windll.user32
    user32.FindWindowW.restype = wintypes.HWND
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    return user32.FindWindowW(None, title)
