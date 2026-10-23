"""Add (or remove) shortcuts that open Sticky To-Do.

    python install_startup.py               open it when you log in (Startup folder)
    python install_startup.py --desktop     add an icon to the desktop
    python install_startup.py --start-menu  add it to the Start menu (so you can pin it to the taskbar)
    python install_startup.py --remove      remove every shortcut this script made

The flags combine, e.g. --desktop --start-menu. Without any, it adds the Startup shortcut.
Shortcuts use the emoji icon picked in the app, and follow it when you change it.
"""

import argparse

from desktop_todo import shortcuts, storage


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--startup", action="store_true", help="open when you log in (the default)")
    parser.add_argument("--desktop", action="store_true", help="add a desktop icon")
    parser.add_argument("--start-menu", action="store_true", help="add a Start menu shortcut")
    parser.add_argument("--remove", action="store_true", help="remove every shortcut")
    args = parser.parse_args()

    if args.remove:
        for path in shortcuts.remove_all_shortcuts():
            print(f"Removed shortcut: {path}")
        return

    chosen = [location for location in shortcuts.SHORTCUT_LOCATIONS if getattr(args, location)] or ["startup"]
    data_dir = storage.get_default_data_dir()
    for location in chosen:
        print(f"Added shortcut: {shortcuts.create_shortcut(location, data_dir)}")
    shortcuts.tell_explorer_icons_changed()


if __name__ == "__main__":
    main()
