"""Only one copy of the app per data folder: a second launch asks the running one to come forward.

Two copies writing the same todo.json could overwrite each other's saves, and that's what happened
when the desktop icon was clicked while the app was hidden as a bubble.

The running copy is found by its bubble window (created hidden at startup, so it always exists),
whose title includes a key for the data folder. The key keeps a test copy with its own data folder
from bumping into the real one.
"""

import ctypes
import hashlib
from ctypes import wintypes

from desktop_todo.bubble_window import CLASS_NAME, WM_APP_BRING_FORWARD

# use_last_error so "the lock already exists" can be read reliably right after CreateMutexW.
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.windll.user32
kernel32.CreateMutexW.restype = wintypes.HANDLE
kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND
user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

ERROR_ALREADY_EXISTS = 183


def get_instance_key(data_dir):
    return hashlib.sha1(str(data_dir).lower().encode("utf-8")).hexdigest()[:10]


def get_bubble_window_title(data_dir):
    return f"Sticky To-Do bubble {get_instance_key(data_dir)}"


def acquire_single_instance_lock(data_dir):
    """The lock's handle if this is the only copy (keep it for the life of the process), else None."""
    handle = kernel32.CreateMutexW(None, False, f"Local\\StickyToDo-{get_instance_key(data_dir)}")
    if not handle:
        return None
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return None
    return handle


def ask_running_instance_to_come_forward(data_dir):
    """Returns False if the running copy's window couldn't be found (e.g. it's still starting up)."""
    window = user32.FindWindowW(CLASS_NAME, get_bubble_window_title(data_dir))
    if not window:
        return False
    # This process was just launched by the user, so it may hand its right to take focus to the
    # running copy; without that, Windows would only flash its taskbar button.
    process_id = wintypes.DWORD()
    user32.GetWindowThreadProcessId(window, ctypes.byref(process_id))
    user32.AllowSetForegroundWindow(process_id.value)
    user32.PostMessageW(window, WM_APP_BRING_FORWARD, 0, 0)
    return True
