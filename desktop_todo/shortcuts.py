"""Windows shortcuts (Startup, Desktop, Start menu) that open Sticky To-Do, and keeping their icon current.

Windows caches shortcut icons by file path, so overwriting one .ico doesn't change what the desktop
shows. Each icon change is written to a new file in `shortcut-icons/`, and existing shortcuts are
repointed at it.
"""

import ctypes
import hashlib
import logging
import os
import subprocess
import sys
from pathlib import Path

log = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent.parent
SHORTCUT_NAME = "Sticky To-Do.lnk"
SHORTCUT_ICONS_FOLDER = "shortcut-icons"

# The [Environment] names for each place a shortcut can live. They're looked up through Windows
# because OneDrive often moves the Desktop into the OneDrive folder.
SHORTCUT_LOCATIONS = {"startup": "Startup", "desktop": "Desktop", "start_menu": "Programs"}

# Values go to PowerShell through environment variables, not string formatting, so a path with
# quotes or $ signs in it can't change what the script does.
CREATE_SHORTCUT_SCRIPT = r"""
$folder = [Environment]::GetFolderPath($env:TODO_FOLDER)
$path = Join-Path $folder $env:TODO_SHORTCUT_NAME
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($path)
$shortcut.TargetPath = $env:TODO_TARGET
$shortcut.Arguments = '"' + $env:TODO_SCRIPT + '"'
$shortcut.WorkingDirectory = $env:TODO_WORKDIR
if ($env:TODO_ICON) { $shortcut.IconLocation = $env:TODO_ICON }
$shortcut.Description = 'Sticky To-Do'
$shortcut.Save()
Write-Output $path
"""

REPOINT_ICONS_SCRIPT = r"""
$shell = New-Object -ComObject WScript.Shell
foreach ($name in $env:TODO_FOLDERS.Split(',')) {
    $path = Join-Path ([Environment]::GetFolderPath($name)) $env:TODO_SHORTCUT_NAME
    if (Test-Path -LiteralPath $path) {
        $shortcut = $shell.CreateShortcut($path)
        $shortcut.IconLocation = $env:TODO_ICON
        $shortcut.Save()
        Write-Output $path
    }
}
"""

REMOVE_SHORTCUTS_SCRIPT = r"""
foreach ($name in $env:TODO_FOLDERS.Split(',')) {
    $path = Join-Path ([Environment]::GetFolderPath($name)) $env:TODO_SHORTCUT_NAME
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path; Write-Output $path }
}
"""


def run_powershell(script, **variables):
    environment = dict(os.environ, TODO_SHORTCUT_NAME=SHORTCUT_NAME, **variables)
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        env=environment, capture_output=True, text=True, check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return [line for line in result.stdout.splitlines() if line.strip()]


def get_windowless_python():
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    if not pythonw.exists():
        raise FileNotFoundError(f"Could not find pythonw.exe next to {sys.executable}; the app needs it to run without a console.")
    return pythonw


def get_newest_shortcut_icon(data_dir):
    icons = sorted((Path(data_dir) / SHORTCUT_ICONS_FOLDER).glob("*.ico"), key=lambda path: path.stat().st_mtime)
    if icons:
        return icons[-1]
    fallback = Path(data_dir) / "icon.ico"
    return fallback if fallback.exists() else None


def save_icon_copy_for_shortcuts(data_dir, icon_path):
    """Copy the icon to a name that changes with its content, and delete older copies."""
    content = Path(icon_path).read_bytes()
    folder = Path(data_dir) / SHORTCUT_ICONS_FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    copy_path = folder / f"icon-{hashlib.sha1(content).hexdigest()[:10]}.ico"
    copy_path.write_bytes(content)
    os.utime(copy_path)
    for old_icon in folder.glob("*.ico"):
        if old_icon != copy_path:
            try:
                old_icon.unlink()
            except OSError:
                pass  # still in use by Explorer; it'll be cleaned up next time
    return copy_path


def create_shortcut(location, data_dir):
    icon_path = get_newest_shortcut_icon(data_dir)
    created = run_powershell(
        CREATE_SHORTCUT_SCRIPT,
        TODO_FOLDER=SHORTCUT_LOCATIONS[location],
        TODO_TARGET=str(get_windowless_python()),
        TODO_SCRIPT=str(APP_DIR / "todo_app.pyw"),
        TODO_WORKDIR=str(APP_DIR),
        TODO_ICON=str(icon_path or ""),
    )
    return created[0] if created else None


def remove_all_shortcuts():
    return run_powershell(REMOVE_SHORTCUTS_SCRIPT, TODO_FOLDERS=",".join(SHORTCUT_LOCATIONS.values()))


def tell_explorer_icons_changed():
    if sys.platform == "win32":
        SHCNE_ASSOCCHANGED, SHCNF_IDLIST = 0x08000000, 0
        ctypes.windll.shell32.SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None)


def repoint_existing_shortcuts_to_icon(data_dir, icon_path):
    """Give any shortcuts that already exist the new icon. Returns the shortcuts it changed."""
    copy_path = save_icon_copy_for_shortcuts(data_dir, icon_path)
    try:
        updated = run_powershell(REPOINT_ICONS_SCRIPT, TODO_FOLDERS=",".join(SHORTCUT_LOCATIONS.values()),
                                 TODO_ICON=str(copy_path))
    except (OSError, subprocess.CalledProcessError) as error:
        log.warning("Could not update the shortcut icons to %s (%s); they keep the old icon.", copy_path, error)
        return []
    tell_explorer_icons_changed()
    return updated
