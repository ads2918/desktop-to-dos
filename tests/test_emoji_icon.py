import tempfile
import unittest
from pathlib import Path

from PIL import Image

from desktop_todo import emoji_icon


def count_colourful_pixels(image):
    return sum(1 for r, g, b, a in image.getdata() if a > 200 and max(r, g, b) - min(r, g, b) > 40)


@unittest.skipUnless(emoji_icon.EMOJI_FONT_PATH.exists(), "Segoe UI Emoji font is only on Windows")
class EmojiIconTests(unittest.TestCase):
    def test_emoji_renders_in_colour_not_black_and_white(self):
        image = emoji_icon.render_emoji_to_image("🔥")
        self.assertGreater(count_colourful_pixels(image), 5000)

    def test_icon_file_is_a_multi_size_ico(self):
        with tempfile.TemporaryDirectory() as folder:
            path = emoji_icon.render_emoji_to_icon_file("🌀", Path(folder) / "icon.ico")
            with Image.open(path) as icon:
                self.assertEqual(icon.format, "ICO")
                self.assertIn((16, 16), icon.info["sizes"])
                self.assertIn((256, 256), icon.info["sizes"])

    def test_joined_emoji_still_renders(self):
        self.assertIsNotNone(emoji_icon.render_emoji_to_image("👨‍💻").getbbox())

    def test_background_colour_puts_the_emoji_on_a_tile_of_that_colour(self):
        image = emoji_icon.render_emoji_to_image("📝", background="#2b86c5")
        # Middle of the left edge is tile, not emoji: close to the chosen blue (the shading shifts it a bit).
        r, g, b, a = image.getpixel((6, 128))
        self.assertEqual(a, 255)
        self.assertLess(abs(r - 0x2b) + abs(g - 0x86) + abs(b - 0xc5), 60)
        # Corners are rounded off, so they stay transparent.
        self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_invalid_background_colour_means_no_tile(self):
        image = emoji_icon.render_emoji_to_image("📝", background="blue")
        self.assertEqual(image.tobytes(), emoji_icon.render_emoji_to_image("📝").tobytes())

    def test_shortcut_icon_copy_gets_a_new_name_per_icon_and_old_ones_are_removed(self):
        from desktop_todo import shortcuts
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            first = shortcuts.save_icon_copy_for_shortcuts(
                data_dir, emoji_icon.render_emoji_to_icon_file("🔥", data_dir / "icon.ico"))
            second = shortcuts.save_icon_copy_for_shortcuts(
                data_dir, emoji_icon.render_emoji_to_icon_file("🌀", data_dir / "icon.ico", "#ff3cac"))
            self.assertNotEqual(first.name, second.name)
            self.assertEqual(list((data_dir / "shortcut-icons").glob("*.ico")), [second])

    def test_empty_or_long_text_is_refused(self):
        with self.assertRaises(ValueError):
            emoji_icon.render_emoji_to_image("  ")
        with self.assertRaises(ValueError):
            emoji_icon.render_emoji_to_image("this is not an emoji at all")


if __name__ == "__main__":
    unittest.main()
