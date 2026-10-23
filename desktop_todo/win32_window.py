"""Move, resize, pin, minimise and maximise the app window through Win32 directly.

Why not pywebview's own window methods: page buttons call Python on a worker thread, and pywebview's
Windows backend then waits on the window's UI thread (Invoke / cross-thread SetWindowPos) while that
thread is itself waiting for the page call to finish. That deadlock froze the app on 📌 and ✕.
Everything here either posts the request without waiting (SWP_ASYNCWINDOWPOS, ShowWindowAsync,
PostMessage) or only reads window state, so it can't block.

Sizes and positions crossing to the page are in physical screen pixels; the page scales pointer
movement by (window width / innerWidth) to match.
"""

import ctypes
import sys
import time
from ctypes import wintypes

IS_WINDOWS = sys.platform == "win32"

HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_ASYNCWINDOWPOS = 0x4000

SW_HIDE = 0
SW_SHOW = 5
SW_MAXIMIZE = 3
SW_MINIMIZE = 6
SW_RESTORE = 9

if IS_WINDOWS:
    user32 = ctypes.windll.user32
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.LONG]
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    user32.GetDpiForWindow.restype = wintypes.UINT
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]


def get_window_rect(window_handle):
    """Physical-pixel x, y, width, height of the window."""
    rect = wintypes.RECT()
    user32.GetWindowRect(window_handle, ctypes.byref(rect))
    return {"x": rect.left, "y": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top}


def get_dpi_scale(window_handle):
    """1.0 at 100% Windows display scaling, 1.5 at 150%, and so on."""
    return (user32.GetDpiForWindow(window_handle) or 96) / 96


def is_window_maximized(window_handle):
    return bool(user32.IsZoomed(window_handle))


def is_window_minimized(window_handle):
    # A minimised window sits at about (-32000, -32000); saving that position once made the app
    # reopen off-screen, showing only in the taskbar.
    return bool(user32.IsIconic(window_handle))


def is_position_on_screen(x, y, width, height):
    """True when at least a grabbable corner of the window is inside the combined monitor area."""
    left, top = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
    right, bottom = left + user32.GetSystemMetrics(78), top + user32.GetSystemMetrics(79)
    return x + width > left + 50 and x < right - 50 and top - 10 <= y < bottom - 50


def enable_taskbar_minimize_and_restore(window_handle):
    """A window without a title bar lacks the minimise-box style, so clicking its taskbar button
    does nothing. Adding WS_MINIMIZEBOX | WS_SYSMENU restores that without bringing the bar back."""
    GWL_STYLE, WS_MINIMIZEBOX, WS_SYSMENU = -16, 0x00020000, 0x00080000
    style = user32.GetWindowLongW(window_handle, GWL_STYLE)
    user32.SetWindowLongW(window_handle, GWL_STYLE, style | WS_MINIMIZEBOX | WS_SYSMENU)


def move_window_async(window_handle, x, y):
    user32.SetWindowPos(window_handle, None, int(x), int(y), 0, 0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)


def resize_window_async(window_handle, width, height):
    user32.SetWindowPos(window_handle, None, 0, 0, int(width), int(height),
                        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)


def set_always_on_top_async(window_handle, on_top):
    user32.SetWindowPos(window_handle, HWND_TOPMOST if on_top else HWND_NOTOPMOST, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)


def minimize_window_async(window_handle):
    user32.ShowWindowAsync(window_handle, SW_MINIMIZE)


def toggle_maximize_window_async(window_handle):
    """Returns True if the window is being maximised, False if restored."""
    maximize = not is_window_maximized(window_handle)
    user32.ShowWindowAsync(window_handle, SW_MAXIMIZE if maximize else SW_RESTORE)
    return maximize


# ---------- bubble mode: the main window hides while the bubble shows ----------


def hide_window_async(window_handle):
    user32.ShowWindowAsync(window_handle, SW_HIDE)


def show_window_and_bring_to_front(window_handle):
    """Call from a background thread, never from inside a page call: it waits briefly."""
    user32.ShowWindowAsync(window_handle, SW_RESTORE if is_window_minimized(window_handle) else SW_SHOW)
    # The show is asynchronous; focusing before it lands can be ignored (seen when restoring from
    # minimised), so ask again once it has had a moment.
    user32.SetForegroundWindow(window_handle)
    time.sleep(0.15)
    user32.SetForegroundWindow(window_handle)
