"""Load and save the sticky notes, the done log and app settings as JSON on local disk.

Data lives in %APPDATA%\\desktop-todo rather than next to the code, because the code sits in OneDrive
and a sync conflict mid-save could clobber the to-do list.
"""

import json
import logging
import os
import re
import shutil
import time
from pathlib import Path

log = logging.getLogger(__name__)

NOTES_FILENAME = "todo.json"
SETTINGS_FILENAME = "settings.json"
DONE_LOG_FILENAME = "done_log.json"
NOTES_FILE_VERSION = 1
DONE_LOG_FILE_VERSION = 1

DATE_KEY_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DONE_ENTRY_KINDS = ("task", "manual")

# Text longer than this is almost certainly a paste accident; cap it so the file stays small.
MAX_TEXT_LENGTH = 2000

NOTE_COLORS = ["yellow", "pink", "green", "blue", "orange", "purple"]

DEFAULT_SETTINGS = {
    "background": "tiedye",
    "customColors": ["#ff3cac", "#784ba0", "#2b86c5"],
    "speed": 1.0,
    "still": False,
    "effect": "water",
    "ambient": False,
    "sound": False,
    "iconEmoji": "📝",
    "iconBackground": "",
    "pinned": True,
    "welcomed": False,
    "bubblePosition": None,
    "window": {"width": 900, "height": 700, "x": None, "y": None},
}


def get_default_data_dir():
    appdata = os.environ.get("APPDATA") or str(Path.home())
    return Path(appdata) / "desktop-todo"


def write_json_file_atomically(path, data):
    """Write to a temp file then swap it in, so a crash mid-write never leaves half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


def read_json_file_or_none(path):
    """Return the parsed JSON, or None if the file is missing or unreadable."""
    path = Path(path)
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as error:
        log.warning("Could not read %s (%s); it will be ignored.", path, error)
        return None


def set_aside_corrupt_file(path):
    """Rename an unreadable file instead of overwriting it, so nothing is lost for good."""
    path = Path(path)
    corrupt_path = path.with_name(f"{path.name}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}")
    try:
        os.replace(path, corrupt_path)
        log.warning("Moved unreadable %s to %s.", path, corrupt_path)
    except OSError as error:
        log.warning("Could not move unreadable %s aside (%s).", path, error)


def clean_text(value):
    return str(value if value is not None else "")[:MAX_TEXT_LENGTH]


def sanitize_task_from_ui(raw_task):
    if not isinstance(raw_task, dict):
        return None
    return {
        "id": clean_text(raw_task.get("id"))[:64],
        "text": clean_text(raw_task.get("text")),
        "done": bool(raw_task.get("done")),
    }


def sanitize_notes_from_ui(raw_notes):
    """Coerce whatever the page sent into the notes shape, dropping anything that isn't a note.

    Returns None when the whole payload is unusable, so the caller can refuse to save rather than
    wipe the list with garbage.
    """
    if not isinstance(raw_notes, list):
        return None
    notes = []
    for index, raw_note in enumerate(raw_notes):
        if not isinstance(raw_note, dict):
            log.warning("Note at position %d is not an object (%r); skipping it.", index, raw_note)
            continue
        color = raw_note.get("color")
        raw_tasks = raw_note.get("tasks")
        tasks = [sanitize_task_from_ui(task) for task in raw_tasks] if isinstance(raw_tasks, list) else []
        notes.append({
            "id": clean_text(raw_note.get("id"))[:64],
            "title": clean_text(raw_note.get("title")),
            "color": color if color in NOTE_COLORS else NOTE_COLORS[0],
            "collapsed": bool(raw_note.get("collapsed")),
            "tasks": [task for task in tasks if task is not None],
        })
    return notes


def read_json_with_backup_fallback(main_path, what):
    """Parsed JSON from main_path, or from its .bak if the main file is damaged (which is set aside)."""
    main_path = Path(main_path)
    backup_path = main_path.with_name(main_path.name + ".bak")
    saved = read_json_file_or_none(main_path)
    if saved is None and main_path.exists():
        set_aside_corrupt_file(main_path)
        saved = read_json_file_or_none(backup_path)
        if saved is not None:
            log.warning("Restored %s from backup %s.", what, backup_path)
    return saved


def write_json_keeping_backup(path, data):
    """Save atomically, keeping the previous save alongside as <name>.bak."""
    path = Path(path)
    if path.exists():
        shutil.copyfile(path, path.with_name(path.name + ".bak"))
    write_json_file_atomically(path, data)


def load_notes_from_disk(data_dir):
    """Return the saved notes, falling back to the backup if the main file is damaged."""
    saved = read_json_with_backup_fallback(Path(data_dir) / NOTES_FILENAME, "notes")
    if saved is None:
        return []
    notes = sanitize_notes_from_ui(saved.get("notes") if isinstance(saved, dict) else None)
    return notes or []


def save_notes_to_disk_atomically(data_dir, notes):
    """Save the notes, keeping the previous save as todo.json.bak."""
    write_json_keeping_backup(Path(data_dir) / NOTES_FILENAME, {"version": NOTES_FILE_VERSION, "notes": notes})


def sanitize_done_entry_from_ui(raw_entry):
    if not isinstance(raw_entry, dict) or not str(raw_entry.get("text") or "").strip():
        return None
    kind = raw_entry.get("kind")
    return {
        "id": clean_text(raw_entry.get("id"))[:64],
        "text": clean_text(raw_entry.get("text")),
        "time": clean_text(raw_entry.get("time"))[:5],
        "noteTitle": clean_text(raw_entry.get("noteTitle"))[:200],
        "taskId": clean_text(raw_entry.get("taskId"))[:64],
        "kind": kind if kind in DONE_ENTRY_KINDS else "manual",
    }


def sanitize_done_log_from_ui(raw_log):
    """The done log is {"YYYY-MM-DD": [entries]}. Returns None if the payload isn't an object at all,
    so the caller refuses to save instead of wiping the history."""
    if not isinstance(raw_log, dict):
        return None
    done_log = {}
    for day, raw_entries in raw_log.items():
        if not DATE_KEY_PATTERN.match(str(day)) or not isinstance(raw_entries, list):
            log.warning("Done log day %r is not a YYYY-MM-DD date with a list of entries; skipping it.", day)
            continue
        entries = [entry for entry in map(sanitize_done_entry_from_ui, raw_entries) if entry is not None]
        if entries:
            done_log[day] = entries
    return done_log


def load_done_log_from_disk(data_dir):
    saved = read_json_with_backup_fallback(Path(data_dir) / DONE_LOG_FILENAME, "done log")
    if not isinstance(saved, dict):
        return {}
    return sanitize_done_log_from_ui(saved.get("days")) or {}


def save_done_log_to_disk_atomically(data_dir, done_log):
    """Save the done log, keeping the previous save as done_log.json.bak."""
    write_json_keeping_backup(Path(data_dir) / DONE_LOG_FILENAME,
                              {"version": DONE_LOG_FILE_VERSION, "days": dict(sorted(done_log.items()))})


def load_settings_from_disk(data_dir):
    """Return saved settings layered over the defaults, so new settings get sensible values."""
    saved = read_json_file_or_none(Path(data_dir) / SETTINGS_FILENAME)
    settings = json.loads(json.dumps(DEFAULT_SETTINGS))
    if isinstance(saved, dict):
        for key, value in saved.items():
            if key in settings:
                settings[key] = value
    if not isinstance(settings["window"], dict):
        settings["window"] = dict(DEFAULT_SETTINGS["window"])
    return settings


def save_settings_to_disk(data_dir, settings):
    write_json_file_atomically(Path(data_dir) / SETTINGS_FILENAME, settings)
