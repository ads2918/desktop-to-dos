# Sticky To-Do

A desktop to-do list that looks like sticky notes. Each note has a header with its tasks underneath,
and everything saves the moment you change it. It sits on top of other windows (toggle with 📌),
over animated tie-dye / vortex / lava-lamp backgrounds, with touch effects such as water ripples,
lightning, melting and raindrops.

## Setup (once)

```bash
pip install -r requirements.txt
```

Then double-click `todo_app.pyw`. The `.pyw` extension runs it without a console window.

To open it automatically when you log in, and to get a Start-menu entry you can pin to the taskbar:

```bash
python install_startup.py --start-menu
```

Run `python install_startup.py --remove` to undo that.

## Using it

| Do this | How |
|---|---|
| New note | **＋ Note** in the toolbar, type a header, press Enter |
| Add a task | Type in a note's "＋ Add a task" box, press Enter |
| Finish a task | Tick it: it's struck through and drops to the bottom |
| Edit a task | Click its text (Enter or clicking away saves, Esc cancels, clearing it deletes it) |
| Fold a note | ▾ / ▸ next to the header; **⇕ Fold all** does every note |
| Reorder notes | Drag the ⠿ handle in the note's header |
| Reorder or move tasks | Drag the ⠿ handle beside a task, within its note, into another, or onto a folded note |
| Move the window | Drag any empty part of the toolbar (double-click it to maximise) |
| Shrink to a bubble | ─ hides the window and shows a round, always-on-top bubble: your emoji over the same background as the window, still moving (unless "Hold still" is on), with a count of unfinished tasks. Drag it anywhere; click (or right-click) it to open the list again |
| See what you finished | 📅 opens the done log: a calendar (days with entries show a count) and the list for the chosen day. Ticked tasks are added automatically (unticking the same day removes them); type in anything else you did |
| Note colour | 🎨 cycles through yellow, pink, green, blue, orange, purple |
| Keep on top | 📌 (faded = not on top) |
| Backgrounds, effects, icon | ⚙️ |

**Backgrounds:** Tie-dye, Sunset, Ocean, Aurora, Neon Acid, Lava Lamp, Cosmic, Vortex, or your own
three colours. There's a speed slider, and "Hold still" freezes the background until you touch it.

**Touch effects:** Water, Raindrops, Thunderstorm, Vortex, Melt, Fireworks, Bubbles, Snow, or Off.
"Ambient" makes the effect happen on its own now and then (rain on the pond, a random lightning
strike). Sound is off until you turn it on.

**App icon:** pick an emoji, or paste any emoji (Win + . opens the emoji picker). It becomes the
title-bar and taskbar icon. Joined emoji like 👨‍💻 show only their first part, because the standard
Windows build of Pillow can't lay them out.

## Where things are saved

`%APPDATA%\desktop-todo\`:

- `done_log.json`: everything you finished, by day (`"2026-10-22": [...]`), each with the time and
  which note it came from. Also backed up as `done_log.json.bak` on every save.
- `todo.json`: your notes. Every save goes to a temp file first and is then swapped in, so a crash
  can't leave half a file. The previous save is kept as `todo.json.bak`.
- `settings.json`: background, effect, icon, pin, and window size and position.
- `icon.ico`: the rendered emoji icon.
- `app.log`: warnings (for example, a damaged file that was set aside).

If `todo.json` can't be read, it's renamed to `todo.json.corrupt-<date>` (never deleted) and the
app loads the backup instead.

The data lives outside OneDrive on purpose: a sync conflict in the middle of a save could clobber
the list.

## Development

- Tests: `python -m unittest`
- Look at the UI in a normal browser: serve the `ui` folder (`python -m http.server` inside `ui/`)
  and open it. Without the desktop bridge it saves to the browser's localStorage, and the settings
  panel says so.
- The UI is plain HTML/CSS/JS in `ui/`. Backgrounds are WebGL shaders (`shaders.js`), and effects
  are drawn on a 2D canvas (`effects.js`). Both stop drawing when nothing is moving, to save CPU.
