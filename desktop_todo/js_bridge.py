"""The object the page calls as `window.pywebview.api.*`.

pywebview runs each call on its own thread, so saves are serialised with a lock and tagged with a
sequence number from the page: if an older save loses the race for the lock, it is dropped instead of
overwriting a newer one. Attributes start with an underscore so pywebview doesn't expose them to JS.

Window controls go through win32_window rather than pywebview's window methods; see that module for
the deadlock this avoids.
"""

import logging
import threading
from pathlib import Path

from desktop_todo import bubble_image, emoji_icon, shortcuts, single_instance, storage, win32_window
from desktop_todo.bubble_window import BubbleWindow

log = logging.getLogger(__name__)

WINDOW_TITLE = "Sticky To-Do"
ICON_FILENAME = "icon.ico"
MIN_WINDOW_SIZE = (360, 300)

# Bubble mode: the ─ button hides the window and shows a round, always-on-top bubble instead (like
# Android chat heads). Sizes are in logical pixels.
BUBBLE_DIAMETER = 68
BUBBLE_MARGIN = 12
# The bubble's background animates by fetching small frames from the hidden page this often.
BUBBLE_FRAMES_PER_SECOND = 10
# Lets the page's call return before windows are swapped (see win32_window docstring).
WINDOW_CHANGE_DELAY_SECONDS = 0.05

# Moving or resizing fires dozens of events a second; write the geometry once things settle.
GEOMETRY_SAVE_DELAY_SECONDS = 0.8


class StickyTodoApi:
    def __init__(self, data_dir):
        self._data_dir = Path(data_dir)
        self._window = None
        self._window_handle = None
        self._save_lock = threading.Lock()
        self._last_saved_notes_sequence = -1
        self._last_saved_done_log_sequence = -1
        self._settings = storage.load_settings_from_disk(self._data_dir)
        self._geometry_timer = None
        self._bubble_mode = False
        self._bubble = None
        self._bubble_animation_stop = threading.Event()

    def _attach_window(self, window):
        self._window = window
        window.events.shown += self._on_window_shown
        # pywebview passes event arguments by matching the handler's parameter list, so spell them out.
        window.events.moved += lambda x, y: self._schedule_geometry_save()
        window.events.resized += lambda width, height: self._schedule_geometry_save()

    def _get_settings(self):
        return self._settings

    def _on_window_shown(self):
        self._window_handle = self._find_window_handle()
        win32_window.enable_taskbar_minimize_and_restore(self._window_handle)
        # Created now (hidden) rather than on first ─, so a second launch can always find this copy.
        self._bubble = BubbleWindow(single_instance.get_bubble_window_title(self._data_dir),
                                    on_click=self._open_window_from_bubble,
                                    on_bring_forward=self._bring_app_forward)
        self._apply_saved_icon_to_window()

    def _find_window_handle(self):
        # pywebview's Windows backend is a WinForms form; its Handle is the HWND. Fall back to a
        # title search if that internal detail ever changes.
        try:
            return int(self._window.native.Handle.ToInt64())
        except Exception:
            return emoji_icon.find_window_handle_by_title(WINDOW_TITLE)

    # ---------- notes & settings ----------

    def load_state(self):
        return {
            "notes": storage.load_notes_from_disk(self._data_dir),
            "doneLog": storage.load_done_log_from_disk(self._data_dir),
            "settings": self._settings,
        }

    def save_notes(self, notes, sequence):
        clean_notes = storage.sanitize_notes_from_ui(notes)
        if clean_notes is None:
            log.warning("Page sent notes that are not a list (%s); not saving, the file is unchanged.",
                        type(notes).__name__)
            return False
        with self._save_lock:
            if sequence <= self._last_saved_notes_sequence:
                return True
            storage.save_notes_to_disk_atomically(self._data_dir, clean_notes)
            self._last_saved_notes_sequence = sequence
        return True

    def save_done_log(self, done_log, sequence):
        clean_log = storage.sanitize_done_log_from_ui(done_log)
        if clean_log is None:
            log.warning("Page sent a done log that is not an object (%s); not saving, the file is unchanged.",
                        type(done_log).__name__)
            return False
        with self._save_lock:
            if sequence <= self._last_saved_done_log_sequence:
                return True
            storage.save_done_log_to_disk_atomically(self._data_dir, clean_log)
            self._last_saved_done_log_sequence = sequence
        return True

    def save_settings(self, settings):
        """Merge page settings in; window size and position are owned by Python, so they're ignored here."""
        if not isinstance(settings, dict):
            log.warning("Page sent settings that are not an object (%s); ignoring them.",
                        type(settings).__name__)
            return False
        with self._save_lock:
            for key, value in settings.items():
                if key in storage.DEFAULT_SETTINGS and key != "window":
                    self._settings[key] = value
            storage.save_settings_to_disk(self._data_dir, self._settings)
        return True

    # ---------- window controls (the window has no Windows title bar) ----------

    def set_pinned(self, pinned):
        pinned = bool(pinned)
        if self._window_handle:
            win32_window.set_always_on_top_async(self._window_handle, pinned)
        self.save_settings({"pinned": pinned})
        return pinned

    def minimize_window(self):
        win32_window.minimize_window_async(self._window_handle)

    def toggle_maximize_window(self):
        return win32_window.toggle_maximize_window_async(self._window_handle)

    def close_window(self):
        """Close after replying to the page: destroying the window from inside this call deadlocks,
        because the window waits for the call to finish and the call waits for the window
        (seen as 'Not Responding' on the close button)."""
        self._save_window_geometry_now()
        threading.Timer(0.1, self._window.destroy).start()

    def get_window_geometry(self):
        """Physical-pixel position and size, for the page's drag and resize-grip code."""
        return win32_window.get_window_rect(self._window_handle)

    def move_window(self, x, y):
        win32_window.move_window_async(self._window_handle, x, y)

    def resize_window(self, width, height):
        scale = win32_window.get_dpi_scale(self._window_handle)
        width = max(MIN_WINDOW_SIZE[0] * scale, width)
        height = max(MIN_WINDOW_SIZE[1] * scale, height)
        win32_window.resize_window_async(self._window_handle, width, height)

    def enter_bubble_mode(self, unfinished_count=0, background_snapshot=None, animated=False):
        """`background_snapshot` is a PNG data URL of the window's current background, so the bubble
        matches it; `animated` keeps the bubble's background moving like the window's."""
        if self._bubble_mode:
            return True
        self._bubble_mode = True
        threading.Timer(WINDOW_CHANGE_DELAY_SECONDS, self._swap_window_for_bubble,
                        args=(int(unfinished_count or 0), background_snapshot, bool(animated))).start()
        return True

    def _swap_window_for_bubble(self, unfinished_count, background_snapshot, animated):
        hwnd = self._window_handle
        scale = win32_window.get_dpi_scale(hwnd)
        diameter = round(BUBBLE_DIAMETER * scale)
        layers = bubble_image.render_bubble_layers(self._settings.get("iconEmoji") or "📝", unfinished_count,
                                                   diameter)
        snapshot = bubble_image.decode_background_snapshot(background_snapshot)
        image = bubble_image.compose_bubble_frame(layers, bubble_image.choose_bubble_fill(
            diameter, snapshot, self._settings.get("iconBackground")))
        x, y = self._get_bubble_position(win32_window.get_window_rect(hwnd), image.width, scale)
        self._bubble.show(image, x, y)
        win32_window.hide_window_async(hwnd)
        if animated and snapshot is not None:
            self._bubble_animation_stop.clear()
            threading.Thread(target=self._animate_bubble, args=(layers,), name="bubble-animation",
                             daemon=True).start()

    def _animate_bubble(self, layers):
        """Fetch frames of the (hidden, but still drawable) page background and repaint the bubble."""
        while not self._bubble_animation_stop.wait(1 / BUBBLE_FRAMES_PER_SECOND):
            try:
                frame = bubble_image.decode_background_snapshot(
                    self._window.evaluate_js("window.captureBubbleFrame && window.captureBubbleFrame()"))
            except Exception as error:
                log.warning("Bubble animation stopped: could not get a frame from the page (%s). "
                            "The bubble keeps its last picture.", error)
                return
            if frame is not None and not self._bubble_animation_stop.is_set():
                self._bubble.repaint(bubble_image.compose_bubble_frame(layers, frame))

    def _get_bubble_position(self, window_rect, bubble_size, scale):
        """Where the bubble was last left, or else just inside the window's top-right corner."""
        saved = self._settings.get("bubblePosition")
        if isinstance(saved, dict) and win32_window.is_position_on_screen(saved.get("x", 0), saved.get("y", 0),
                                                                          bubble_size, bubble_size):
            return saved["x"], saved["y"]
        margin = round(BUBBLE_MARGIN * scale)
        return window_rect["x"] + window_rect["width"] - bubble_size - margin, window_rect["y"] + margin

    def _bring_app_forward(self):
        """Another launch of the app asked this copy to come forward: open the full window, whether
        it's shrunk to the bubble, minimised, or just behind other windows."""
        if self._bubble_mode:
            self._open_window_from_bubble()
        else:
            win32_window.show_window_and_bring_to_front(self._window_handle)

    def _open_window_from_bubble(self):
        """Runs on the bubble's thread when it's clicked."""
        self._bubble_animation_stop.set()
        x, y = self._bubble.get_position()
        self.save_settings({"bubblePosition": {"x": x, "y": y}})
        self._bubble.hide()
        win32_window.show_window_and_bring_to_front(self._window_handle)
        self._bubble_mode = False
        try:
            self._window.evaluate_js("window.resumeAfterBubble && window.resumeAfterBubble()")
        except Exception as error:
            log.warning("Could not restart the background animation after the bubble (%s); "
                        "it resumes on the next touch or resize.", error)

    def _schedule_geometry_save(self):
        if self._geometry_timer is not None:
            self._geometry_timer.cancel()
        self._geometry_timer = threading.Timer(GEOMETRY_SAVE_DELAY_SECONDS, self._save_window_geometry_now)
        self._geometry_timer.daemon = True
        self._geometry_timer.start()

    def _save_window_geometry_now(self):
        # A maximised, minimised or bubbled window's position isn't the one to come back to next time.
        if (not self._window_handle or self._bubble_mode
                or win32_window.is_window_maximized(self._window_handle)
                or win32_window.is_window_minimized(self._window_handle)):
            return
        # Saved in logical pixels (what create_window takes), so 150% display scaling doesn't grow
        # the window by half on every launch.
        rect = win32_window.get_window_rect(self._window_handle)
        scale = win32_window.get_dpi_scale(self._window_handle)
        with self._save_lock:
            self._settings["window"] = {key: round(value / scale) for key, value in rect.items()}
            storage.save_settings_to_disk(self._data_dir, self._settings)

    # ---------- emoji icon ----------

    def set_icon_emoji(self, emoji, background=""):
        """Render the icon, put it on the window and taskbar, and repoint any desktop/Start shortcuts."""
        background = background if emoji_icon.parse_hex_colour(background) else ""
        try:
            icon_path = emoji_icon.render_emoji_to_icon_file(emoji, self._data_dir / ICON_FILENAME, background)
        except (ValueError, OSError) as error:
            log.warning("Could not make an icon from %r (%s); keeping the current icon.", emoji, error)
            return {"ok": False, "error": str(error), "shortcutsUpdated": 0}
        self._apply_saved_icon_to_window(icon_path)
        self.save_settings({"iconEmoji": emoji, "iconBackground": background})
        updated = shortcuts.repoint_existing_shortcuts_to_icon(self._data_dir, icon_path)
        return {"ok": True, "error": "", "shortcutsUpdated": len(updated)}

    def _apply_saved_icon_to_window(self, icon_path=None):
        icon_path = Path(icon_path or self._data_dir / ICON_FILENAME)
        if not icon_path.exists():
            try:
                emoji_icon.render_emoji_to_icon_file(self._settings.get("iconEmoji") or "📝", icon_path,
                                                     self._settings.get("iconBackground"))
            except (ValueError, OSError) as error:
                log.warning("Could not make the startup icon (%s); using the default icon.", error)
                return
        emoji_icon.apply_icon_file_to_window_handle(self._window_handle, icon_path)
