import json
import tempfile
import unittest
from pathlib import Path

from desktop_todo import storage
from desktop_todo.js_bridge import StickyTodoApi

SAMPLE_NOTES = [
    {"id": "n1", "title": "Invoices", "color": "pink", "collapsed": False,
     "tasks": [{"id": "t1", "text": "Approve bill", "done": False},
               {"id": "t2", "text": "Chase PO", "done": True}]},
]


class StorageTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._temp.name)

    def tearDown(self):
        self._temp.cleanup()

    def test_saved_notes_load_back_unchanged(self):
        storage.save_notes_to_disk_atomically(self.data_dir, SAMPLE_NOTES)
        self.assertEqual(storage.load_notes_from_disk(self.data_dir), SAMPLE_NOTES)

    def test_missing_file_loads_as_no_notes(self):
        self.assertEqual(storage.load_notes_from_disk(self.data_dir), [])

    def test_second_save_keeps_the_first_as_backup(self):
        storage.save_notes_to_disk_atomically(self.data_dir, SAMPLE_NOTES)
        storage.save_notes_to_disk_atomically(self.data_dir, [])
        backup = json.loads((self.data_dir / "todo.json.bak").read_text(encoding="utf-8"))
        self.assertEqual(backup["notes"], SAMPLE_NOTES)

    def test_corrupt_file_falls_back_to_backup_and_is_kept_aside(self):
        storage.save_notes_to_disk_atomically(self.data_dir, SAMPLE_NOTES)
        storage.save_notes_to_disk_atomically(self.data_dir, SAMPLE_NOTES)
        (self.data_dir / "todo.json").write_text("{not json", encoding="utf-8")

        with self.assertLogs("desktop_todo.storage", level="WARNING"):
            notes = storage.load_notes_from_disk(self.data_dir)

        self.assertEqual(notes, SAMPLE_NOTES)
        self.assertEqual(len(list(self.data_dir.glob("todo.json.corrupt-*"))), 1)

    def test_sanitize_drops_junk_and_fixes_bad_values(self):
        raw = [
            "not a note",
            {"id": "n1", "title": None, "color": "chartreuse", "tasks": [{"text": "x" * 5000, "done": 1}, 7]},
        ]
        with self.assertLogs("desktop_todo.storage", level="WARNING"):
            notes = storage.sanitize_notes_from_ui(raw)
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["color"], "yellow")
        self.assertEqual(notes[0]["title"], "")
        self.assertEqual(len(notes[0]["tasks"]), 1)
        self.assertEqual(len(notes[0]["tasks"][0]["text"]), storage.MAX_TEXT_LENGTH)
        self.assertIs(notes[0]["tasks"][0]["done"], True)

    def test_sanitize_refuses_a_payload_that_is_not_a_list(self):
        self.assertIsNone(storage.sanitize_notes_from_ui({"notes": []}))

    def test_settings_fill_in_defaults_for_missing_keys(self):
        storage.save_settings_to_disk(self.data_dir, {"background": "lava", "unknown": 1})
        settings = storage.load_settings_from_disk(self.data_dir)
        self.assertEqual(settings["background"], "lava")
        self.assertEqual(settings["effect"], storage.DEFAULT_SETTINGS["effect"])
        self.assertNotIn("unknown", settings)


SAMPLE_DONE_LOG = {
    "2026-10-22": [
        {"id": "d1", "text": "Approve bill", "time": "14:32", "noteTitle": "Invoices", "taskId": "t1", "kind": "task"},
        {"id": "d2", "text": "Walked the shop floor", "time": "16:05", "noteTitle": "", "taskId": "", "kind": "manual"},
    ],
}


class DoneLogTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._temp.name)

    def tearDown(self):
        self._temp.cleanup()

    def test_done_log_saves_and_loads_back(self):
        storage.save_done_log_to_disk_atomically(self.data_dir, SAMPLE_DONE_LOG)
        self.assertEqual(storage.load_done_log_from_disk(self.data_dir), SAMPLE_DONE_LOG)

    def test_missing_done_log_is_empty(self):
        self.assertEqual(storage.load_done_log_from_disk(self.data_dir), {})

    def test_bad_days_and_blank_entries_are_dropped(self):
        raw = {"yesterday": [{"text": "x"}], "2026-10-21": [{"text": "  "}, "junk", {"text": "Real", "kind": "weird"}]}
        with self.assertLogs("desktop_todo.storage", level="WARNING"):
            done_log = storage.sanitize_done_log_from_ui(raw)
        self.assertEqual(list(done_log), ["2026-10-21"])
        self.assertEqual([entry["text"] for entry in done_log["2026-10-21"]], ["Real"])
        self.assertEqual(done_log["2026-10-21"][0]["kind"], "manual")

    def test_corrupt_done_log_falls_back_to_backup(self):
        storage.save_done_log_to_disk_atomically(self.data_dir, SAMPLE_DONE_LOG)
        storage.save_done_log_to_disk_atomically(self.data_dir, SAMPLE_DONE_LOG)
        (self.data_dir / "done_log.json").write_text("{oops", encoding="utf-8")
        with self.assertLogs("desktop_todo.storage", level="WARNING"):
            self.assertEqual(storage.load_done_log_from_disk(self.data_dir), SAMPLE_DONE_LOG)

    def test_bridge_refuses_a_done_log_that_is_not_an_object(self):
        api = StickyTodoApi(self.data_dir)
        api.save_done_log(SAMPLE_DONE_LOG, 1)
        with self.assertLogs("desktop_todo.js_bridge", level="WARNING"):
            self.assertFalse(api.save_done_log(["not", "a", "log"], 2))
        self.assertEqual(storage.load_done_log_from_disk(self.data_dir), SAMPLE_DONE_LOG)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._temp.name)
        self.api = StickyTodoApi(self.data_dir)

    def tearDown(self):
        self._temp.cleanup()

    def test_an_older_save_arriving_late_does_not_overwrite_a_newer_one(self):
        self.api.save_notes(SAMPLE_NOTES, 2)
        self.api.save_notes([], 1)
        self.assertEqual(storage.load_notes_from_disk(self.data_dir), SAMPLE_NOTES)

    def test_garbage_notes_payload_leaves_the_file_alone(self):
        self.api.save_notes(SAMPLE_NOTES, 1)
        with self.assertLogs("desktop_todo.js_bridge", level="WARNING"):
            self.assertFalse(self.api.save_notes("oops", 2))
        self.assertEqual(storage.load_notes_from_disk(self.data_dir), SAMPLE_NOTES)

    def test_page_settings_cannot_overwrite_window_geometry(self):
        self.api.save_settings({"effect": "melt", "window": {"width": 1}})
        settings = storage.load_settings_from_disk(self.data_dir)
        self.assertEqual(settings["effect"], "melt")
        self.assertEqual(settings["window"], storage.DEFAULT_SETTINGS["window"])


if __name__ == "__main__":
    unittest.main()
