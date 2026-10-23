"""The floating bubble: a tiny native, always-on-top window showing a picture with real transparency.

Why a separate native window rather than shrinking the web window: the web view can't be made
see-through on Windows (it painted black or square corners), whereas a layered window shows the
bubble image's own alpha, so only the circle and its shadow appear.

The window lives on its own thread with its own message loop. Dragging uses Windows' native
window dragging (the whole bubble reports itself as a title bar); a press that doesn't move the
bubble counts as a click and calls `on_click`.

It's created hidden when the app starts, so it can also receive the "come forward" message from a
second launch of the app (see single_instance), which calls `on_bring_forward`.
"""

import ctypes
import logging
import threading
from ctypes import wintypes

log = logging.getLogger(__name__)

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

WS_POPUP = 0x80000000
WS_EX_LAYERED, WS_EX_TOPMOST, WS_EX_TOOLWINDOW = 0x00080000, 0x00000008, 0x00000080
WM_DESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCRBUTTONUP, WM_APP = 0x0002, 0x0084, 0x00A1, 0x00A5, 0x8000
WM_APP_SHOW, WM_APP_HIDE, WM_APP_REPAINT = WM_APP + 1, WM_APP + 2, WM_APP + 3
# Sent by a second launch of the app (see single_instance) asking this copy to come forward.
WM_APP_BRING_FORWARD = WM_APP + 4
HTCAPTION = 2
SW_HIDE, SW_SHOWNOACTIVATE = 0, 4
ULW_ALPHA, AC_SRC_OVER, AC_SRC_ALPHA = 0x2, 0x0, 0x1
BI_RGB, DIB_RGB_COLORS = 0, 0
CLASS_NAME = "StickyToDoBubble"


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("style", wintypes.UINT), ("lpfnWndProc", WNDPROC),
                ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE),
                ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [("BlendOp", ctypes.c_byte), ("BlendFlags", ctypes.c_byte),
                ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_byte)]


user32.DefWindowProcW.restype = LRESULT
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.UpdateLayeredWindow.argtypes = [wintypes.HWND, wintypes.HDC, ctypes.POINTER(wintypes.POINT),
                                       ctypes.POINTER(wintypes.SIZE), wintypes.HDC, ctypes.POINTER(wintypes.POINT),
                                       wintypes.COLORREF, ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD]
user32.LoadCursorW.restype = wintypes.HANDLE
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p),
                                   wintypes.HANDLE, wintypes.DWORD]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]


def get_window_position(window_handle):
    rect = wintypes.RECT()
    user32.GetWindowRect(window_handle, ctypes.byref(rect))
    return rect.left, rect.top


def paint_image_on_layered_window(window_handle, image, x=None, y=None):
    """Show an RGBA Pillow image as the window's whole look, transparency included. Without x/y the
    window stays where it is (so animation frames don't fight a drag in progress)."""
    width, height = image.size
    # Layered windows want premultiplied alpha in BGRA order ("RGBa" is Pillow's premultiplied mode).
    pixels = image.convert("RGBa").tobytes("raw", "BGRa")

    header = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), width, -height, 1, 32, BI_RGB, 0, 0, 0, 0, 0)
    screen_dc = user32.GetDC(None)
    memory_dc = gdi32.CreateCompatibleDC(screen_dc)
    bits = ctypes.c_void_p()
    bitmap = gdi32.CreateDIBSection(memory_dc, ctypes.byref(header), DIB_RGB_COLORS, ctypes.byref(bits), None, 0)
    ctypes.memmove(bits, pixels, len(pixels))
    previous = gdi32.SelectObject(memory_dc, bitmap)
    try:
        blend = BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)
        position = ctypes.byref(wintypes.POINT(int(x), int(y))) if x is not None else None
        user32.UpdateLayeredWindow(window_handle, screen_dc, position,
                                   ctypes.byref(wintypes.SIZE(width, height)), memory_dc,
                                   ctypes.byref(wintypes.POINT(0, 0)), 0, ctypes.byref(blend), ULW_ALPHA)
    finally:
        gdi32.SelectObject(memory_dc, previous)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(memory_dc)
        user32.ReleaseDC(None, screen_dc)


class BubbleWindow:
    """Owns the bubble's window handle and the thread its message loop runs on."""

    def __init__(self, title, on_click, on_bring_forward):
        self._title = title
        self._on_click = on_click
        self._on_bring_forward = on_bring_forward
        self._window_handle = None
        self._ready = threading.Event()
        self._pending = None  # (image, x, y) waiting for the bubble thread to paint
        self._pending_frame = None  # latest animation frame; older unpainted ones are just skipped
        self._window_procedure = WNDPROC(self._handle_message)  # kept referenced so it isn't freed
        threading.Thread(target=self._run_message_loop, name="bubble", daemon=True).start()
        self._ready.wait(5)

    def show(self, image, x, y):
        """Thread-safe: hands the picture to the bubble thread, which paints and shows it."""
        self._pending = (image, x, y)
        user32.PostMessageW(self._window_handle, WM_APP_SHOW, 0, 0)

    def repaint(self, image):
        """Thread-safe: swap in a new picture (an animation frame) without moving the bubble."""
        self._pending_frame = image
        user32.PostMessageW(self._window_handle, WM_APP_REPAINT, 0, 0)

    def hide(self):
        user32.PostMessageW(self._window_handle, WM_APP_HIDE, 0, 0)

    def get_position(self):
        return get_window_position(self._window_handle)

    def _run_message_loop(self):
        instance = kernel32.GetModuleHandleW(None)
        window_class = WNDCLASSEXW()
        window_class.cbSize = ctypes.sizeof(WNDCLASSEXW)
        window_class.lpfnWndProc = self._window_procedure
        window_class.hInstance = instance
        window_class.hCursor = user32.LoadCursorW(None, ctypes.c_void_p(32649))  # IDC_HAND
        window_class.lpszClassName = CLASS_NAME
        user32.RegisterClassExW(ctypes.byref(window_class))
        # Tool window: no taskbar button of its own. Topmost: floats above everything.
        self._window_handle = user32.CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW, CLASS_NAME, self._title, WS_POPUP,
            0, 0, 1, 1, None, None, instance, None)
        self._ready.set()
        message = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))

    def _handle_message(self, window_handle, message, wparam, lparam):
        try:
            if message == WM_NCHITTEST:
                return HTCAPTION  # the whole bubble drags like a title bar
            if message == WM_NCLBUTTONDOWN:
                # DefWindowProc runs Windows' drag loop and returns once the button is released;
                # if the bubble didn't move, it was a click.
                before = get_window_position(window_handle)
                user32.DefWindowProcW(window_handle, message, wparam, lparam)
                if get_window_position(window_handle) == before:
                    self._on_click()
                return 0
            if message == WM_NCRBUTTONUP:
                self._on_click()
                return 0
            if message == WM_APP_SHOW and self._pending:
                image, x, y = self._pending
                paint_image_on_layered_window(window_handle, image, x, y)
                user32.ShowWindow(window_handle, SW_SHOWNOACTIVATE)
                return 0
            if message == WM_APP_REPAINT and self._pending_frame is not None:
                frame, self._pending_frame = self._pending_frame, None
                paint_image_on_layered_window(window_handle, frame)
                return 0
            if message == WM_APP_BRING_FORWARD:
                self._on_bring_forward()
                return 0
            if message == WM_APP_HIDE:
                user32.ShowWindow(window_handle, SW_HIDE)
                return 0
        except Exception:
            log.exception("Bubble window failed handling message %#x; leaving it to Windows.", message)
        return user32.DefWindowProcW(window_handle, message, wparam, lparam)
