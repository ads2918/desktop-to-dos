// Sticky notes UI: notes with a header and tasks, saved on every change.
// In the desktop app saves go through Python (window.pywebview.api); opened in a plain browser for
// a quick look, it falls back to localStorage and says so in the settings panel.

(() => {
  const NOTE_COLORS = ["yellow", "pink", "green", "blue", "orange", "purple"];
  const ICON_EMOJIS = ["📝", "✅", "🗒️", "📌", "🔥", "⚡", "🌀", "🌈", "🍄", "🦄", "🐙", "🌊", "🌵", "🚀", "🎯", "💎",
                       "🧠", "☕", "🍕", "🎸", "👽", "🤖", "🦖", "🌻", "🪐", "🌋", "🧿", "🎨", "🌙", "⭐", "🍀", "🐝"];
  // "" = no tile, just the emoji on a transparent background.
  const ICON_COLOURS = ["", "#ff3cac", "#7a4dd8", "#2b86c5", "#13b5a6", "#3fb950", "#ffc83d", "#ff7a1a", "#e5384f", "#22202b"];
  const TITLE_SAVE_DELAY_MS = 400;
  const LOCAL_STORAGE_KEY = "sticky-todo-browser-preview";

  // doneLog: {"YYYY-MM-DD": [{id, text, time, noteTitle, taskId, kind: "task" | "manual"}]}
  const state = { notes: [], doneLog: {}, settings: {} };
  let backend = null;
  let saveSequence = 0;
  let doneLogSaveSequence = 0;
  let pendingFocus = null;
  let draggedNoteId = null;
  let noteIdAwaitingDeleteConfirm = null;
  const titleSaveTimers = new Map();

  const board = document.getElementById("board");
  const saveStatus = document.getElementById("save-status");

  // ---------- saving ----------

  function createPywebviewBackend() {
    const api = window.pywebview.api;
    return {
      kind: "desktop",
      loadState: () => api.load_state(),
      saveNotes: (notes, sequence) => api.save_notes(notes, sequence),
      saveDoneLog: (doneLog, sequence) => api.save_done_log(doneLog, sequence),
      saveSettings: (settings) => api.save_settings(settings),
      setPinned: (pinned) => api.set_pinned(pinned),
      setIcon: (emoji, background) => api.set_icon_emoji(emoji, background),
      minimizeWindow: () => api.minimize_window(),
      enterBubbleMode: (unfinishedCount, backgroundSnapshot, animated) =>
        api.enter_bubble_mode(unfinishedCount, backgroundSnapshot, animated),
      toggleMaximizeWindow: () => api.toggle_maximize_window(),
      closeWindow: () => api.close_window(),
      resizeWindow: (width, height) => api.resize_window(width, height),
      moveWindow: (x, y) => api.move_window(x, y),
      getWindowGeometry: () => api.get_window_geometry(),
    };
  }

  function createBrowserPreviewBackend() {
    const read = () => {
      try { return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)) || {}; } catch { return {}; }
    };
    const write = (patch) => {
      try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...read(), ...patch })); } catch { /* private mode */ }
      return true;
    };
    return {
      kind: "browser",
      loadState: async () => ({ notes: read().notes || [], doneLog: read().doneLog || {}, settings: read().settings || {} }),
      saveNotes: async (notes) => write({ notes }),
      saveDoneLog: async (doneLog) => write({ doneLog }),
      saveSettings: async (patch) => write({ settings: { ...read().settings, ...patch } }),
      setPinned: async (pinned) => pinned,
      setIcon: async () => ({ ok: true, error: "", shortcutsUpdated: 0 }),
    };
  }

  function waitForPywebview(timeoutMs) {
    return new Promise((resolve) => {
      if (window.pywebview && window.pywebview.api) return resolve(true);
      const timer = setTimeout(() => resolve(false), timeoutMs);
      window.addEventListener("pywebviewready", () => { clearTimeout(timer); resolve(true); }, { once: true });
    });
  }

  function showSaveStatus(text, isError = false) {
    saveStatus.textContent = text;
    saveStatus.classList.toggle("error", isError);
  }

  async function saveNotes() {
    const sequence = ++saveSequence;
    showSaveStatus("Saving…");
    try {
      const ok = await backend.saveNotes(state.notes, sequence);
      if (sequence === saveSequence) showSaveStatus(ok ? "Saved ✓" : "Not saved!", !ok);
    } catch (error) {
      console.error("Saving notes failed:", error);
      showSaveStatus("Not saved!", true);
    }
  }

  async function saveDoneLog() {
    const sequence = ++doneLogSaveSequence;
    try {
      if (!(await backend.saveDoneLog(state.doneLog, sequence))) showSaveStatus("Done log not saved!", true);
    } catch (error) {
      console.error("Saving the done log failed:", error);
      showSaveStatus("Done log not saved!", true);
    }
  }

  function saveSettings(patch) {
    Object.assign(state.settings, patch);
    backend.saveSettings(patch).catch((error) => console.error("Saving settings failed:", error));
  }

  // ---------- note & task changes (each one saves) ----------

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  const findNote = (noteId) => state.notes.find((note) => note.id === noteId);

  function addNote() {
    const color = NOTE_COLORS[state.notes.length % NOTE_COLORS.length];
    const note = { id: newId(), title: "", color, collapsed: false, tasks: [] };
    state.notes.unshift(note);
    pendingFocus = { noteId: note.id, selector: ".note-title" };
    commitChange();
  }

  function addTask(noteId, text) {
    const note = findNote(noteId);
    if (!note || !text.trim()) return;
    // New tasks go after the last unfinished one, keeping finished tasks at the bottom.
    const firstDoneIndex = note.tasks.findIndex((task) => task.done);
    const insertAt = firstDoneIndex === -1 ? note.tasks.length : firstDoneIndex;
    note.tasks.splice(insertAt, 0, { id: newId(), text: text.trim(), done: false });
    pendingFocus = { noteId, selector: ".add-task-input" };
    commitChange();
  }

  function toggleTask(noteId, taskId) {
    const note = findNote(noteId);
    const index = note.tasks.findIndex((task) => task.id === taskId);
    const [task] = note.tasks.splice(index, 1);
    task.done = !task.done;
    if (task.done) {
      note.tasks.push(task);
      logCompletedTask(note, task);
    } else {
      unlogTaskCompletedToday(task.id);
      const firstDoneIndex = note.tasks.findIndex((other) => other.done);
      note.tasks.splice(firstDoneIndex === -1 ? note.tasks.length : firstDoneIndex, 0, task);
    }
    commitChange();
  }

  function updateTaskText(noteId, taskId, text) {
    const note = findNote(noteId);
    if (!text.trim()) return deleteTask(noteId, taskId);
    note.tasks.find((task) => task.id === taskId).text = text.trim();
    commitChange();
  }

  // `index` is the position among the target note's tasks once the moved task has been taken out.
  function moveTask(fromNoteId, taskId, toNoteId, index) {
    const from = findNote(fromNoteId);
    const to = findNote(toNoteId);
    const [task] = from.tasks.splice(from.tasks.findIndex((candidate) => candidate.id === taskId), 1);
    to.tasks.splice(Math.min(index, to.tasks.length), 0, task);
    commitChange();
  }

  function deleteTask(noteId, taskId) {
    const note = findNote(noteId);
    note.tasks = note.tasks.filter((task) => task.id !== taskId);
    commitChange();
  }

  function deleteNote(noteId) {
    state.notes = state.notes.filter((note) => note.id !== noteId);
    noteIdAwaitingDeleteConfirm = null;
    commitChange();
  }

  function cycleNoteColor(noteId) {
    const note = findNote(noteId);
    note.color = NOTE_COLORS[(NOTE_COLORS.indexOf(note.color) + 1) % NOTE_COLORS.length];
    commitChange();
  }

  function toggleNoteCollapsed(noteId) {
    const note = findNote(noteId);
    note.collapsed = !note.collapsed;
    commitChange();
  }

  function toggleAllCollapsed() {
    const collapse = state.notes.some((note) => !note.collapsed);
    state.notes.forEach((note) => { note.collapsed = collapse; });
    commitChange();
  }

  function moveNote(noteId, targetNoteId, placeAfter) {
    if (noteId === targetNoteId) return;
    const moving = findNote(noteId);
    state.notes = state.notes.filter((note) => note.id !== noteId);
    const targetIndex = state.notes.findIndex((note) => note.id === targetNoteId);
    state.notes.splice(targetIndex + (placeAfter ? 1 : 0), 0, moving);
    commitChange();
  }

  function scheduleTitleSave(noteId, title) {
    findNote(noteId).title = title;
    clearTimeout(titleSaveTimers.get(noteId));
    titleSaveTimers.set(noteId, setTimeout(saveNotes, TITLE_SAVE_DELAY_MS));
  }

  function commitChange() {
    renderBoard();
    saveNotes();
  }

  // ---------- rendering ----------

  function element(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function tiltForNote(noteId) {
    // Same small tilt every time for a given note, so they don't jiggle on each re-render.
    let hash = 0;
    for (const char of noteId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return ((Math.abs(hash) % 300) / 100 - 1.5).toFixed(2) + "deg";
  }

  function renderTask(note, task) {
    const text = element("span", { className: "task-text", textContent: task.text, title: "Click to edit" });
    text.addEventListener("click", () => startEditingTask(note.id, task, text));
    return element("li", { className: "task" + (task.done ? " done" : ""), dataset: { noteId: note.id, taskId: task.id } }, [
      element("span", { className: "task-handle", textContent: "⠿", title: "Drag to reorder (or into another note)" }),
      element("input", { type: "checkbox", checked: task.done, title: task.done ? "Mark not done" : "Mark done",
                         onchange: () => toggleTask(note.id, task.id) }),
      text,
      element("button", { className: "note-button", textContent: "✕", title: "Delete task",
                          onclick: () => deleteTask(note.id, task.id) }),
    ]);
  }

  // A text box that grows with the text, so long tasks stay readable while editing.
  // Enter or clicking away saves, Esc cancels, and clearing the text deletes the task.
  function startEditingTask(noteId, task, textElement) {
    const input = element("textarea", { className: "task-edit-input", value: task.text, maxLength: 2000, rows: 1 });
    const fitHeightToText = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      if (save && input.value !== task.text) updateTaskText(noteId, task.id, input.value);
      else renderBoard();
    };
    input.addEventListener("input", fitHeightToText);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    textElement.replaceWith(input);
    fitHeightToText();
    // Cursor at the end rather than everything selected: with a single click to edit, a selected
    // task would be wiped by the first key pressed.
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function renderDeleteConfirm(note) {
    const taskWord = note.tasks.length === 1 ? "task" : "tasks";
    return element("div", { className: "confirm-delete" }, [
      element("span", { textContent: `Delete this note and its ${note.tasks.length} ${taskWord}?` }),
      element("button", { className: "danger", textContent: "Delete", onclick: () => deleteNote(note.id) }),
      element("button", { textContent: "Keep", onclick: () => { noteIdAwaitingDeleteConfirm = null; renderBoard(); } }),
    ]);
  }

  function renderNote(note) {
    const doneCount = note.tasks.filter((task) => task.done).length;
    const handle = element("button", { className: "note-button drag-handle", textContent: "⠿", title: "Drag to move" });
    const noteElement = element("section", {
      className: "note" + (note.collapsed ? " collapsed" : ""),
      dataset: { id: note.id, color: note.color },
    });
    noteElement.style.setProperty("--tilt", tiltForNote(note.id));
    wireNoteDragging(noteElement, handle, note.id);

    const header = element("header", { className: "note-header" }, [
      handle,
      element("button", { className: "note-button", textContent: note.collapsed ? "▸" : "▾",
                          title: note.collapsed ? "Expand" : "Collapse", onclick: () => toggleNoteCollapsed(note.id) }),
      element("input", { className: "note-title", value: note.title, placeholder: "Header…", maxLength: 2000,
                         oninput: (event) => scheduleTitleSave(note.id, event.target.value),
                         onkeydown: (event) => { if (event.key === "Enter") noteElement.querySelector(".add-task-input")?.focus(); } }),
      element("span", { className: "task-count", textContent: `${doneCount}/${note.tasks.length}` }),
      element("button", { className: "note-button", textContent: "🎨", title: "Change colour", onclick: () => cycleNoteColor(note.id) }),
      element("button", { className: "note-button", textContent: "✕", title: "Delete note",
                          onclick: () => { noteIdAwaitingDeleteConfirm = note.id; renderBoard(); } }),
    ]);

    const addInput = element("input", { className: "add-task-input", placeholder: "＋ Add a task, press Enter", maxLength: 2000 });
    addInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addTask(note.id, addInput.value);
    });

    const body = element("div", { className: "note-body" }, [
      element("ul", { className: "task-list" }, note.tasks.map((task) => renderTask(note, task))),
      addInput,
    ]);

    noteElement.append(header, noteIdAwaitingDeleteConfirm === note.id ? renderDeleteConfirm(note) : "", body);
    return noteElement;
  }

  function renderBoard() {
    if (state.notes.length === 0) {
      board.replaceChildren(element("div", { className: "empty-board" }, [
        element("p", { textContent: "No notes yet." }),
        element("button", { className: "toolbar-button", textContent: "＋ Add your first note", onclick: addNote }),
      ]));
      return;
    }
    board.replaceChildren(...state.notes.map(renderNote));
    if (pendingFocus) {
      board.querySelector(`.note[data-id="${CSS.escape(pendingFocus.noteId)}"] ${pendingFocus.selector}`)?.focus();
      pendingFocus = null;
    }
  }

  // ---------- dragging notes to reorder ----------

  function clearDropMarkers() {
    board.querySelectorAll(".drop-before, .drop-after").forEach((node) => node.classList.remove("drop-before", "drop-after"));
  }

  function wireNoteDragging(noteElement, handle, noteId) {
    // Only the handle starts a drag, so selecting text in the inputs still works.
    handle.addEventListener("pointerdown", () => { noteElement.draggable = true; });
    noteElement.addEventListener("dragstart", (event) => {
      draggedNoteId = noteId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", noteId);
      noteElement.classList.add("dragging");
    });
    noteElement.addEventListener("dragend", () => {
      noteElement.draggable = false;
      noteElement.classList.remove("dragging");
      clearDropMarkers();
      draggedNoteId = null;
    });
    noteElement.addEventListener("dragover", (event) => {
      if (!draggedNoteId || draggedNoteId === noteId) return;
      event.preventDefault();
      const box = noteElement.getBoundingClientRect();
      const after = event.clientX > box.left + box.width / 2;
      clearDropMarkers();
      noteElement.classList.add(after ? "drop-after" : "drop-before");
    });
    noteElement.addEventListener("drop", (event) => {
      if (!draggedNoteId) return;
      event.preventDefault();
      const after = noteElement.classList.contains("drop-after");
      clearDropMarkers();
      moveNote(draggedNoteId, noteId, after);
    });
  }

  // ---------- dragging tasks to reorder (within a note or into another) ----------
  // Pointer events rather than HTML drag-and-drop, so it works the same with mouse and touchscreen
  // and the task can follow the pointer as a lifted card.

  const AUTO_SCROLL_EDGE_PX = 50;

  function wireTaskDragging() {
    let drag = null;

    board.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest(".task-handle");
      if (!handle || event.button !== 0) return;
      event.preventDefault();
      const item = handle.closest(".task");
      const box = item.getBoundingClientRect();
      const placeholder = element("li", { className: "task-placeholder" });
      placeholder.style.height = `${box.height}px`;
      item.after(placeholder);
      // Lift the task onto <body>: notes are rotated, and a rotated parent would make
      // position: fixed relative to the note instead of the window.
      item.style.setProperty("--note-color", getComputedStyle(item).getPropertyValue("--note-color"));
      item.classList.add("task-dragging");
      Object.assign(item.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` });
      document.body.append(item);
      handle.setPointerCapture(event.pointerId);
      drag = { item, placeholder, offsetX: event.clientX - box.left, offsetY: event.clientY - box.top, collapsedTarget: null };
    });

    // On document, not board: the lifted task lives on <body> while it's being dragged.
    document.addEventListener("pointermove", (event) => {
      if (!drag) return;
      drag.item.style.left = `${event.clientX - drag.offsetX}px`;
      drag.item.style.top = `${event.clientY - drag.offsetY}px`;
      if (event.clientY < AUTO_SCROLL_EDGE_PX) window.scrollBy(0, -12);
      if (event.clientY > window.innerHeight - AUTO_SCROLL_EDGE_PX) window.scrollBy(0, 12);
      movePlaceholderUnderPointer(drag, event.clientX, event.clientY);
    });

    document.addEventListener("pointerup", () => {
      if (!drag) return;
      const finished = drag;
      drag = null;
      dropDraggedTask(finished);
      finished.item.remove();
    });

    document.addEventListener("pointercancel", () => {
      if (!drag) return;
      drag.item.remove();
      drag = null;
      renderBoard();
    });
  }

  function movePlaceholderUnderPointer(drag, x, y) {
    // The lifted task has pointer-events: none, so this finds what's underneath it.
    const note = document.elementFromPoint(x, y)?.closest(".note");
    board.querySelectorAll(".note.drop-target").forEach((node) => node.classList.remove("drop-target"));
    drag.collapsedTarget = null;
    drag.placeholder.hidden = false;
    if (!note) return;

    if (note.classList.contains("collapsed")) {
      // A folded note has no visible list; dropping on it adds the task to the end.
      note.classList.add("drop-target");
      drag.collapsedTarget = note.dataset.id;
      drag.placeholder.hidden = true;
      return;
    }
    const list = note.querySelector(".task-list");
    const others = [...list.children].filter((child) => child !== drag.item && child !== drag.placeholder);
    const before = others.find((child) => {
      const box = child.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    list.insertBefore(drag.placeholder, before || null);
  }

  function dropDraggedTask(drag) {
    board.querySelectorAll(".note.drop-target").forEach((node) => node.classList.remove("drop-target"));
    const { noteId, taskId } = drag.item.dataset;
    if (drag.collapsedTarget) {
      const target = findNote(drag.collapsedTarget);
      return moveTask(noteId, taskId, target.id, target.tasks.length);
    }
    const targetNote = drag.placeholder.closest(".note");
    const siblings = [...drag.placeholder.parentElement.children].filter((child) => child !== drag.item);
    const index = siblings.indexOf(drag.placeholder);
    const unchanged = targetNote.dataset.id === noteId
      && findNote(noteId).tasks.findIndex((task) => task.id === taskId) === index;
    if (unchanged) return renderBoard();
    moveTask(noteId, taskId, targetNote.dataset.id, index);
  }

  // ---------- done log: what got finished each day ----------

  const logView = { selectedDay: null, shownMonth: null };

  // Local calendar day, not UTC, so a task ticked at 9 pm lands on today rather than tomorrow.
  function toDayKey(date) {
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function fromDayKey(dayKey) {
    const [year, month, day] = dayKey.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function currentTimeLabel() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  function formatTimeLabel(time) {
    const [hours, minutes] = (time || "").split(":").map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return "";
    return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function addDoneEntry(dayKey, entry) {
    (state.doneLog[dayKey] ||= []).push({ id: newId(), time: currentTimeLabel(), noteTitle: "", taskId: "", ...entry });
    saveDoneLog();
    renderDoneLogIfOpen();
  }

  function logCompletedTask(note, task) {
    addDoneEntry(toDayKey(new Date()), { text: task.text, noteTitle: note.title, taskId: task.id, kind: "task" });
  }

  // Unticking by mistake shouldn't leave a false "done" behind. Only today's entry is removed:
  // a task finished on an earlier day stays in that day's history.
  function unlogTaskCompletedToday(taskId) {
    const today = toDayKey(new Date());
    const entries = state.doneLog[today] || [];
    const index = entries.map((entry) => entry.taskId).lastIndexOf(taskId);
    if (index === -1) return;
    entries.splice(index, 1);
    if (!entries.length) delete state.doneLog[today];
    saveDoneLog();
    renderDoneLogIfOpen();
  }

  function deleteDoneEntry(dayKey, entryId) {
    state.doneLog[dayKey] = (state.doneLog[dayKey] || []).filter((entry) => entry.id !== entryId);
    if (!state.doneLog[dayKey].length) delete state.doneLog[dayKey];
    saveDoneLog();
    renderDoneLog();
  }

  function renderCalendar() {
    const month = logView.shownMonth;
    document.getElementById("calendar-month").textContent =
      month.toLocaleDateString([], { month: "long", year: "numeric" });
    const today = toDayKey(new Date());
    const cells = ["S", "M", "T", "W", "T", "F", "S"].map((letter) =>
      element("div", { className: "calendar-weekday", textContent: letter }));
    for (let blank = 0; blank < month.getDay(); blank++) cells.push(element("div"));
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dayKey = toDayKey(new Date(month.getFullYear(), month.getMonth(), day));
      const count = (state.doneLog[dayKey] || []).length;
      const classes = ["calendar-day", dayKey === today && "today", dayKey === logView.selectedDay && "selected",
                       count && "has-entries"].filter(Boolean).join(" ");
      cells.push(element("button", {
        className: classes, title: count ? `${count} done` : "",
        onclick: () => { logView.selectedDay = dayKey; renderDoneLog(); },
      }, [String(day), count ? element("span", { className: "day-count", textContent: String(count) }) : null]));
    }
    document.getElementById("calendar-grid").replaceChildren(...cells);
  }

  function renderDayEntries() {
    const dayKey = logView.selectedDay;
    const isToday = dayKey === toDayKey(new Date());
    document.getElementById("log-day-title").textContent = (isToday ? "Today · " : "")
      + fromDayKey(dayKey).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const entries = state.doneLog[dayKey] || [];
    document.getElementById("log-entries").replaceChildren(...(entries.length ? entries.map((entry) =>
      element("li", { className: "log-entry" }, [
        element("span", { className: "log-entry-time", textContent: formatTimeLabel(entry.time) }),
        element("span", { className: "log-entry-text", textContent: entry.text }, [
          entry.noteTitle ? element("span", { className: "log-entry-note", textContent: entry.noteTitle }) : null,
        ]),
        element("button", { className: "delete-entry", textContent: "✕", title: "Remove from the log",
                            onclick: () => deleteDoneEntry(dayKey, entry.id) }),
      ])) : [element("li", { className: "log-empty", textContent: "Nothing logged for this day." })]));
  }

  function renderDoneLog() {
    renderCalendar();
    renderDayEntries();
  }

  function renderDoneLogIfOpen() {
    if (!document.getElementById("log-panel").hidden) renderDoneLog();
  }

  function showDoneLogDay(date) {
    logView.selectedDay = toDayKey(date);
    logView.shownMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    renderDoneLog();
  }

  function wireDoneLogPanel() {
    const panel = document.getElementById("log-panel");
    document.getElementById("log-button").onclick = () => {
      if (toggleSidePanel(panel)) showDoneLogDay(new Date());
    };
    document.getElementById("close-log-button").onclick = closeSidePanels;
    document.getElementById("log-today-button").onclick = () => showDoneLogDay(new Date());
    const changeMonth = (delta) => {
      const month = logView.shownMonth;
      logView.shownMonth = new Date(month.getFullYear(), month.getMonth() + delta, 1);
      renderCalendar();
    };
    document.getElementById("previous-month-button").onclick = () => changeMonth(-1);
    document.getElementById("next-month-button").onclick = () => changeMonth(1);
    const input = document.getElementById("log-add-input");
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !input.value.trim()) return;
      addDoneEntry(logView.selectedDay, { text: input.value.trim(), kind: "manual" });
      input.value = "";
    });
  }

  // ---------- settings panel ----------

  function markPressed(container, attribute, value) {
    container.querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
    });
  }

  function customGradientCss() {
    return `linear-gradient(0deg, ${state.settings.customColors.join(", ")})`;
  }

  function buildBackgroundChoices() {
    const container = document.getElementById("background-choices");
    container.replaceChildren(...Backgrounds.PRESETS.map((preset) => {
      const button = element("button", { className: "swatch", textContent: preset.label, dataset: { background: preset.id },
                                         onclick: () => chooseBackground(preset.id) });
      button.style.background = preset.css || customGradientCss();
      return button;
    }));
  }

  function chooseBackground(id) {
    Backgrounds.setPreset(id);
    saveSettings({ background: id });
    markPressed(document.getElementById("background-choices"), "background", id);
    document.getElementById("custom-colors").hidden = id !== "custom";
  }

  function buildEffectChoices() {
    const container = document.getElementById("effect-choices");
    container.replaceChildren(...Effects.EFFECTS.map((effect) => element("button", {
      className: "chip", textContent: effect.label, dataset: { effect: effect.id },
      onclick: () => {
        Effects.setEffect(effect.id);
        saveSettings({ effect: effect.id });
        markPressed(container, "effect", effect.id);
      },
    })));
  }

  function showIconPreview(emoji, background) {
    const preview = document.getElementById("icon-preview");
    preview.textContent = emoji;
    preview.classList.toggle("has-tile", Boolean(background));
    preview.style.background = background
      ? `linear-gradient(180deg, color-mix(in srgb, ${background}, white 25%), color-mix(in srgb, ${background}, black 15%))`
      : "transparent";
    document.getElementById("app-emoji").textContent = emoji;
    markPressed(document.getElementById("emoji-choices"), "emoji", emoji);
    markPressed(document.getElementById("icon-colour-choices"), "colour", background);
  }

  // Renders the icon in Python and updates the window, taskbar and any desktop/Start shortcuts.
  async function setIcon({ emoji = state.settings.iconEmoji || "📝", background = state.settings.iconBackground || "" }) {
    const message = document.getElementById("emoji-message");
    emoji = emoji.trim();
    if (!emoji) return;
    message.textContent = "Making icon…";
    const result = await backend.setIcon(emoji, background);
    if (!result.ok) {
      message.textContent = result.error;
      return;
    }
    state.settings.iconEmoji = emoji;
    state.settings.iconBackground = background;
    if (backend.kind === "browser") saveSettings({ iconEmoji: emoji, iconBackground: background });
    showIconPreview(emoji, background);
    if (backend.kind === "browser") {
      message.textContent = "Icon changes show in the desktop app.";
    } else if (result.shortcutsUpdated) {
      message.textContent = "Icon updated on the taskbar and your shortcuts (the desktop can take a few seconds).";
    } else {
      message.textContent = "Icon updated on the taskbar.";
    }
  }

  function buildEmojiChoices() {
    document.getElementById("emoji-choices").replaceChildren(...ICON_EMOJIS.map((emoji) => element("button", {
      className: "emoji-choice", textContent: emoji, dataset: { emoji }, onclick: () => setIcon({ emoji }),
    })));
  }

  function buildIconColourChoices() {
    const container = document.getElementById("icon-colour-choices");
    const customPicker = container.querySelector(".custom-colour");
    const swatches = ICON_COLOURS.map((colour) => {
      const button = element("button", {
        className: "colour-choice" + (colour ? "" : " no-colour"),
        title: colour ? `Tile colour ${colour}` : "No tile, just the emoji",
        dataset: { colour },
        onclick: () => setIcon({ background: colour }),
      });
      if (colour) button.style.background = colour;
      return button;
    });
    container.replaceChildren(...swatches, customPicker);
    const input = document.getElementById("icon-colour-input");
    input.addEventListener("input", () => showIconPreview(state.settings.iconEmoji || "📝", input.value));
    input.addEventListener("change", () => setIcon({ background: input.value }));
  }

  function setPinnedButton(pinned) {
    const button = document.getElementById("pin-button");
    button.setAttribute("aria-pressed", String(pinned));
    button.title = pinned ? "Pinned on top — click to unpin" : "Not on top — click to pin above other windows";
  }

  // Settings and the done log share the right-hand side; only one is open at a time.
  function closeSidePanels() {
    document.querySelectorAll(".settings-panel").forEach((panel) => { panel.hidden = true; });
  }

  function toggleSidePanel(panel) {
    const opening = panel.hidden;
    closeSidePanels();
    panel.hidden = !opening;
    return opening;
  }

  function wireSettingsPanel() {
    const panel = document.getElementById("settings-panel");
    document.getElementById("settings-button").onclick = () => toggleSidePanel(panel);
    document.getElementById("close-settings-button").onclick = closeSidePanels;
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSidePanels(); });

    document.querySelectorAll("#custom-colors input").forEach((input) => {
      input.value = state.settings.customColors[Number(input.dataset.index)];
      input.addEventListener("input", () => {
        const colors = state.settings.customColors.slice();
        colors[Number(input.dataset.index)] = input.value;
        Backgrounds.setCustomColors(colors);
        state.settings.customColors = colors;
        document.querySelector('.swatch[data-background="custom"]').style.background = customGradientCss();
      });
      input.addEventListener("change", () => saveSettings({ customColors: state.settings.customColors }));
    });

    const speed = document.getElementById("speed-slider");
    speed.value = state.settings.speed;
    speed.addEventListener("input", () => Backgrounds.setSpeed(speed.value));
    speed.addEventListener("change", () => saveSettings({ speed: Number(speed.value) }));

    const wireCheckbox = (id, key, apply) => {
      const checkbox = document.getElementById(id);
      checkbox.checked = Boolean(state.settings[key]);
      checkbox.addEventListener("change", () => { apply(checkbox.checked); saveSettings({ [key]: checkbox.checked }); });
    };
    wireCheckbox("still-checkbox", "still", Backgrounds.setStill);
    wireCheckbox("ambient-checkbox", "ambient", Effects.setAmbient);
    wireCheckbox("sound-checkbox", "sound", Effects.setSound);

    const emojiInput = document.getElementById("emoji-input");
    document.getElementById("emoji-apply-button").onclick = () => setIcon({ emoji: emojiInput.value });
    emojiInput.addEventListener("keydown", (event) => { if (event.key === "Enter") setIcon({ emoji: emojiInput.value }); });

    document.getElementById("storage-note").textContent = backend.kind === "desktop"
      ? "Notes save automatically to %APPDATA%\\desktop-todo\\todo.json."
      : "Browser preview: notes are saved in this browser only. Open todo_app.pyw for the desktop app.";
  }

  // ---------- start-up ----------

  function applySettings() {
    const settings = state.settings;
    settings.customColors = Array.isArray(settings.customColors) && settings.customColors.length === 3
      ? settings.customColors : ["#ff3cac", "#784ba0", "#2b86c5"];
    Backgrounds.setCustomColors(settings.customColors);
    Backgrounds.setSpeed(settings.speed ?? 1);
    Backgrounds.setStill(Boolean(settings.still));
    Backgrounds.setPreset(settings.background || "tiedye");
    Effects.setEffect(settings.effect || "water");
    Effects.setAmbient(Boolean(settings.ambient));
    Effects.setSound(Boolean(settings.sound));
    setPinnedButton(settings.pinned !== false);

    buildBackgroundChoices();
    buildEffectChoices();
    buildEmojiChoices();
    buildIconColourChoices();
    markPressed(document.getElementById("background-choices"), "background", settings.background || "tiedye");
    markPressed(document.getElementById("effect-choices"), "effect", settings.effect || "water");
    showIconPreview(settings.iconEmoji || "📝", settings.iconBackground || "");
    document.getElementById("custom-colors").hidden = settings.background !== "custom";
  }

  // The desktop window has no Windows title bar, so the page supplies the buttons and resize grip.
  function wireWindowControls() {
    if (backend.kind !== "desktop") return;
    document.getElementById("window-controls").hidden = false;
    document.getElementById("minimize-button").onclick = shrinkToBubble;
    const toggleMaximize = async () => {
      const maximized = await backend.toggleMaximizeWindow();
      document.getElementById("maximize-button").textContent = maximized ? "❐" : "□";
    };
    document.getElementById("maximize-button").onclick = toggleMaximize;
    document.getElementById("close-button").onclick = () => backend.closeWindow();
    // Any part of the toolbar that isn't a control moves the window, so there's always somewhere to
    // grab, even when the window is too narrow for an empty gap between the buttons.
    const toolbar = document.querySelector(".toolbar");
    const isOnControl = (event) => Boolean(event.target.closest("button, input, label, select"));
    toolbar.addEventListener("dblclick", (event) => { if (!isOnControl(event)) toggleMaximize(); });
    followPointerDrag(toolbar, (start, dx, dy) => backend.moveWindow(start.x + dx, start.y + dy),
                      (event) => !isOnControl(event));
    const grip = document.getElementById("resize-grip");
    grip.hidden = false;
    followPointerDrag(grip, (start, dx, dy) => backend.resizeWindow(start.width + dx, start.height + dy));
  }

  // ---------- bubble mode ----------
  // ─ hides the window and Python shows a round, always-on-top bubble: the emoji and the number of
  // unfinished tasks over a snapshot of the current background; clicking the bubble brings it back.

  function shrinkToBubble() {
    const unfinished = state.notes.reduce((count, note) => count + note.tasks.filter((task) => !task.done).length, 0);
    closeSidePanels();
    const snapshot = Backgrounds.captureSquareSnapshot();
    Backgrounds.setPaused(true);
    Effects.setPaused(true);
    backend.enterBubbleMode(unfinished, snapshot, Backgrounds.isAnimated());
  }

  // Python calls this when the window comes back from the bubble.
  window.resumeAfterBubble = () => {
    Backgrounds.setPaused(false);
    Effects.setPaused(false);
  };

  // Python calls this (via evaluate_js) several times a second while the bubble shows, so the
  // bubble's background keeps moving like the full window's. Small JPEGs keep each frame cheap.
  window.captureBubbleFrame = () => Backgrounds.captureSquareSnapshot(112, "image/jpeg", true);

  // Drags the window (or its size) with the pointer. pywebview's own drag-region support didn't
  // move the window here, so the page tracks the pointer itself and asks Python to move/resize.
  // `apply(start, dx, dy)` gets the window geometry at pointer-down and the distance moved so far;
  // `shouldStart(event)` can turn down a pointer-down (e.g. one on a button).
  function followPointerDrag(element, apply, shouldStart = () => true) {
    let start = null;
    let pending = null;
    let callInFlight = false;

    // Only one call to Python at a time; the latest pointer position wins, so dragging stays smooth.
    async function sendLatest() {
      if (callInFlight || !pending || !start) return;
      callInFlight = true;
      const { dx, dy } = pending;
      pending = null;
      try { await apply(start, dx, dy); } finally { callInFlight = false; }
      sendLatest();
    }

    element.addEventListener("pointerdown", async (event) => {
      if (event.button !== 0 || event.detail > 1 || !shouldStart(event)) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      const pointerStart = { x: event.screenX, y: event.screenY };
      const geometry = await backend.getWindowGeometry();
      // Python reports the window in physical pixels; pointer positions are in CSS pixels.
      start = { ...geometry, pointer: pointerStart, scale: geometry.width / window.innerWidth };
    });
    element.addEventListener("pointermove", (event) => {
      if (!start) return;
      pending = {
        dx: Math.round((event.screenX - start.pointer.x) * start.scale),
        dy: Math.round((event.screenY - start.pointer.y) * start.scale),
      };
      sendLatest();
    });
    const stop = () => { start = null; pending = null; };
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  }

  function wireToolbar() {
    document.getElementById("add-note-button").onclick = addNote;
    document.getElementById("collapse-all-button").onclick = toggleAllCollapsed;
    document.getElementById("pin-button").onclick = async () => {
      const pinned = await backend.setPinned(state.settings.pinned === false);
      state.settings.pinned = pinned;
      if (backend.kind === "browser") saveSettings({ pinned });
      setPinnedButton(pinned);
    };
  }

  function wireTouchEffects() {
    document.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".toolbar, .settings-panel, .resize-grip, .task-handle")) return;
      Effects.trigger(event.clientX, event.clientY);
    });
  }

  async function start() {
    Backgrounds.init(document.getElementById("background-canvas"));
    Effects.init(document.getElementById("effects-canvas"), {
      flash: document.getElementById("flash-overlay"),
      shakeTarget: board,
    });

    backend = (await waitForPywebview(2500)) ? createPywebviewBackend() : createBrowserPreviewBackend();
    if (backend.kind === "browser") {
      // If the desktop bridge turns up late, reload so saves go to the real file, not the browser.
      window.addEventListener("pywebviewready", () => location.reload(), { once: true });
    }
    const saved = await backend.loadState();
    state.notes = Array.isArray(saved.notes) ? saved.notes : [];
    state.doneLog = saved.doneLog && typeof saved.doneLog === "object" ? saved.doneLog : {};
    state.settings = saved.settings || {};

    if (state.notes.length === 0 && !state.settings.welcomed) {
      state.notes = [{ id: newId(), title: "Today", color: "yellow", collapsed: false, tasks: [
        { id: newId(), text: "Tap the background to make a splash", done: false },
        { id: newId(), text: "Try ⚙️ for tie-dye, vortex & thunderstorms", done: false },
      ] }];
      saveSettings({ welcomed: true });
      saveNotes();
    }

    applySettings();
    wireToolbar();
    wireWindowControls();
    wireSettingsPanel();
    wireDoneLogPanel();
    wireTouchEffects();
    wireTaskDragging();
    renderBoard();
  }

  start();
})();
