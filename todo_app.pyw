"""Sticky To-Do: double-click to open (the .pyw extension runs it without a console window)."""

import logging
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

import webview  # noqa: E402

from desktop_todo import emoji_icon, single_instance, storage, win32_window  # noqa: E402
from desktop_todo.js_bridge import MIN_WINDOW_SIZE, WINDOW_TITLE, StickyTodoApi  # noqa: E402


def configure_logging_to_file(data_dir):
    # pythonw has no console, so anything worth knowing goes to a log file next to the data.
    data_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=data_dir / "app.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        encoding="utf-8",
    )


def get_saved_window_geometry_if_on_screen(settings):
    """Saved size and position, or a centred default position if the saved one is off every screen."""
    geometry = settings["window"]
    width = max(MIN_WINDOW_SIZE[0], int(geometry.get("width") or 900))
    height = max(MIN_WINDOW_SIZE[1], int(geometry.get("height") or 700))
    x, y = geometry.get("x"), geometry.get("y")
    if x is not None and y is not None and not win32_window.is_position_on_screen(x, y, width, height):
        logging.getLogger(__name__).warning(
            "Saved window position (%s, %s) is off-screen; opening centred instead.", x, y)
        x = y = None
    return width, height, x, y


def create_main_window(api):
    settings = api._get_settings()
    width, height, x, y = get_saved_window_geometry_if_on_screen(settings)
    window = webview.create_window(
        WINDOW_TITLE,
        # A file:// URL loads straight from disk. A plain path makes pywebview start a local web server
        # on a random port, which failed on this PC when the port fell in a range Windows reserves.
        url=(APP_DIR / "ui" / "index.html").as_uri(),
        js_api=api,
        width=width,
        height=height,
        x=x,
        y=y,
        min_size=MIN_WINDOW_SIZE,
        on_top=bool(settings.get("pinned", True)),
        background_color="#1b1030",
        text_select=True,
        # No Windows title bar: the toolbar's empty space drags the window, and the page draws its
        # own minimise / maximise / close buttons and resize grip.
        frameless=True,
        easy_drag=False,
    )
    api._attach_window(window)
    return window


def main():
    data_dir = storage.get_default_data_dir()
    configure_logging_to_file(data_dir)
    # Kept for the whole run: holding it is what tells later launches this copy is open.
    instance_lock = single_instance.acquire_single_instance_lock(data_dir)
    if instance_lock is None:
        if not single_instance.ask_running_instance_to_come_forward(data_dir):
            logging.getLogger(__name__).info("Sticky To-Do is already starting; this launch is closing.")
        return
    emoji_icon.set_taskbar_identity_for_this_process()
    api = StickyTodoApi(data_dir)
    create_main_window(api)
    webview.start(private_mode=False, storage_path=str(data_dir / "webview"))


if __name__ == "__main__":
    main()
