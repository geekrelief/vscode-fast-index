# Fast Project Indexer ⚡️

**Fast Project Indexer** is a VS Code extension that brings instant, JetBrains-style full-text search and replace functionality to your workspace.

Instead of searching text "on the fly" for every query, the plugin builds an inverted trigram index in the background once, providing instantaneous search results even in massive codebases.

## Key Features

* **Instant Search:** Results appear as you type (from 3 characters) with zero lag. The search box takes focus when the panel opens and doubles as an editable combo box: recent searches drop down from the ▾ button on the right, `↑`/`↓` walk them, `Enter` runs the highlighted one. The list size is `fastIndex.maxRecentSearches` (default 20, 0 disables it).
* **No surprise prefills:** opening the panel never restores the previous query and never seeds the box from the editor cursor — it starts empty. It is only seeded when you open it with an explicit **selection** in the editor; while the panel is open, moving the cursor onto a word (or selecting text) keeps the box in sync. Opening or switching files does not count as a cursor move. Toggle the whole behaviour with `fastIndex.followEditor` (or the checkbox in the panel settings), or freeze it temporarily with the 🔒 title-bar lock.
* **Replace keeps the index current:** applying a replacement re-indexes the affected buffers immediately, and searching reads open (dirty) documents, so replaced text disappears from results and new text is findable without saving first.
* **Results in the editor:** the book icon in the title bar (**Fast Index: Open Results in Editor**) opens the current results as a real editor tab, written in VS Code's own search-editor format so the built-in `search-result` language gives it theme-driven syntax highlighting, Follow-link targets and peek-on-click. It is driven by the panel and refreshed in place. Set `fastIndex.autoOpenResults` to have it open itself after a search.
* **Preview panel:** a read-only preview docked in the bottom panel next to the terminal — run **Fast Index: Open Preview Panel** or pick *Fast Index Preview* from the panel's view menu. It follows whichever result the sidebar is resting on, highlights the **search term itself** inside the matched line, and clicking any line opens that file at that line. It is styled from the editor's own theme: `editor.background`/`foreground`, font family, size, weight and `editor.lineHeight`, line-number gutter colours, current-line highlight, selection and scrollbar colours, plus the theme's `tokenColors` for syntax.
* **Balanced results:** at most `fastIndex.maxResultsPerFile` matching lines per file (default 3, 0 = unlimited) and a fair share of the result list per workspace folder, so one huge engine file can no longer hide your own project's hits.
* **Title-bar buttons:** the 🔒/🔓 lock, ⚙️ settings and ☰ menu sit in the view's title bar next to the name, like the built-in Search view. The 🔒 **lock** freezes the search — clicking or moving the cursor in the editor no longer refills the query, so results stay put while you read code; the state survives reloads. The ☰ menu offers pinned-search show/hide, the preview panel and the search log.
* **Pinned searches:** the 📌 button saves the current search — term, `Aa`/`.*`, `Only in`, `Skip`, the results filter and your collapsed tree branches. Pins live in a scrollable, resizable box anchored at the bottom of the panel (drag its top edge to resize, or hide it from the ☰ menu); each shows the main term with its extra parameters (scope, filter, `Aa`/`.*`) in muted text beneath, so pins with the same term stay distinguishable. Click one to restore the whole state, or use its ✕ to remove it. Kept per workspace and across sessions by `fastIndex.persistPinnedSearches` (default on; turn it off — or untick it in the panel settings — to keep pins for the session only).
* **Search log:** the ☰ menu's *Show the search log* opens a **Fast Index** output panel that records every search with its trigger (typing, pin, filter, scope, prefill…), its scope/filter and the result counts, plus prefills that were ignored and why, and searches superseded by a newer one. Use it when results change unexpectedly.
* **Latest search wins:** starting a search cancels the one in flight; stale results are discarded instead of overwriting the newer list.
* **Search scope:** Two boxes under the search input narrow any query without reindexing. `Only in` and `Skip` accept comma-separated tokens that match **partially**: an extension (`cpp`, `cp`, `h`), a file or folder fragment (`Char`, `Game`, `Source/Game`), or an exact suffix (`.h`, `*.ini`). Examples: only C++ sources → `cpp`; headers → `h` or `.h`; only Python → `py`; one directory → `Source/Game`; skip build output → `Intermediate, Test`.
* **Filename matches first:** Files whose *name* matches the query are listed above content-only matches — exact name matches first, then prefix matches, then partial ones, then path-qualified queries (`GameFramework/Character.h`). A file whose name matches but whose content never mentions the query is still listed, marked `file name match`.
* **Tree view:** Results can be shown as a directory tree grouped by path and then by **file** — matches in the same file sit under one file node with their line numbers, so a file with many hits collapses to a single row. Expanded all the way down by default. Every directory and file node expands/collapses on click; expanding a directory walks straight down single-child chains and leaves the children of branching folders as they were, and **Expand all** / **Collapse all** work on the whole tree; right-clicking a directory offers **Collapse all below** / **Expand all below** for that branch — **Collapse all below** leaves the node itself open and folds only its contents, while **Expand all below** unfolds it completely. **☰ List** switches back to a flat list.
* **Filter results:** The box directly under the search field is a boolean modifier of the search — a row must match both the query and the filter (by file name or line text). It survives new searches, `Only in` / `Skip` edits and result refreshes, and clearing it re-runs the query. Every text field shows a ✕ on hover to clear it.
* **Trigram Indexing:** Searches not just by whole words, but by word parts (e.g., `calc` will find `calculateTotalPrice`).
* **Find & Replace:** Easily replace text across multiple files or one-by-one with an intuitive UI. Supports multiline code snippets and safe replacements via VS Code's `WorkspaceEdit` (Ctrl+Z to undo).
* **Advanced Matching:** Toggle Case-Sensitive (`Aa`) matching or Regular Expressions (`.*`) right from the search bar.
* **Native Sidebar Integration:** A dedicated activity bar icon ⚡️ ensures the search doesn't clutter your built-in tools. Keeps its state even when you switch tabs.
* **Multithreading:** Heavy file parsing is offloaded to background OS threads. Your VS Code UI won't freeze during indexing.
* **Disk Caching & Live Updates:** The index is saved locally and instantly loads upon restart. Live file watchers keep the index accurate as you code.

## How to Use

1. Open your project in VS Code.
2. Click on the **Lightning Bolt (⚡️)** icon in the Activity Bar on the left.
3. If it's your first time, the plugin will ask to build the index. You can also click the **⚙️** title-bar button and select **Save & Reindex**.
4. Start typing (at least 3 characters) — results with code highlighting will appear instantly. Click on a result to jump directly to the matched line.
5. Click **▼ Replace** to open the replace panel. Hover over a result and click `Replace` for a surgical fix, or use `Replace All`.
6. Use the `Aa` or `.*` toggles in the search input to use case-sensitive or RegEx searches.
7. Press 📌 to pin the current search, or the book icon to open the results as a real editor tab.

## Configuration

You can customize the extension directly via the **⚙️** title-bar button:

* **Include Extensions:** Limit indexing to specific file types (e.g., `ts,js,md`). Leave empty to index everything.
* **Exclude Patterns:** Glob patterns for files/folders to ignore (e.g., `{**/node_modules/**,**/.git/**}`).
* **Max File Size (KB):** Prevent the indexer from choking on huge minified or binary files (default is `512` KB).
* **Max Search Results:** Limit the number of snippets shown to keep the UI responsive (default is `50`).
* **Preview Hover Delay:** Milliseconds to rest the pointer on a result before the Preview Panel updates (default `1500`, 0 = instant).
* **Preview Context Lines:** Lines shown above and below a match (default `2`).
* **Keep pinned searches between sessions:** on/off (default on).
* **Open the results editor automatically:** on/off (default off, also `fastIndex.autoOpenResults`). When on, a search that finds matches reopens the results tab if you closed it — without stealing focus, so you can keep typing in the panel.
* **Follow editor selection / word under cursor:** on/off.
* **Cached indexes:** The settings panel lists every cached workspace folder with its build date and size. Tick the ones you want to drop (or **Select all**) and press **Delete selected**; a confirmation dialog is shown before anything is deleted. **Reindex selected** re-scans only the ticked folders and leaves the other caches untouched. Caches whose folder no longer exists are marked **missing**, and **Delete stale** removes all of them in one confirmed step. A deleted folder is re-indexed only when you run **Fast Index: Build Project Index**.

## Where the index lives

One cache segment per workspace folder, shared by every workspace that contains that folder:

```
%APPDATA%\Code\User\globalStorage\eric.vscode-fast-index\fast-index\root-<folder-hash>.v4.bin
```

Each segment is a gzip-compressed binary file — roughly 34 MB for the Unreal Engine source tree — plus a small `<segment>.journal` holding edits made while VS Code was running.

## Performance

The segment stores a per-trigram index table, so a cold start reads only the small tables: **~0.5 s and ~460 MB RSS for 138k files** instead of decoding all ~65 M postings (4.7 s, 1.9 GB). Posting lists are decoded on demand for the handful of trigrams a query needs, and cached.

Each file's size and mtime are stored with the index, so a reindex **skips unchanged files entirely** — no read, no trigram pass. Reindexing an unchanged engine folder is a directory walk, and reindexing a project folder after a few edits touches only those files. Files that disappeared lose their postings; updated files replace theirs exactly.

## Architecture (Under the Hood)

The index is built from trigrams: every word of three or more characters contributes its overlapping trigrams, mapped to file ids. A search intersects the posting lists of the query's trigrams (in memory, as `Uint32` arrays) and decodes only those lists. Results are ranked so file-name matches come first. When searching with regular expressions or special-character-only queries, the plugin falls back to scanning the indexed files concurrently.

The preview surfaces share `src/theme.ts`, which resolves `workbench.colorTheme` to its theme file on disk, follows `include` chains and JSONC syntax, and maps the relevant TextMate scopes onto the preview's token categories.

## Changelog — current development session

Everything below landed in one session (0.3.6 → 0.9.2).

### Search UI

* Moved **Filter these results** directly under the search field, matching its styling (`.input-group`), and made it a **boolean modifier of the search**: a row must match both the query and the filter, applied host-side so the scan keeps going until it has enough matching rows.
* The filter now survives new searches, `Only in` / `Skip` edits and result refreshes; clearing it re-runs the query.
* Added a **✕ clear button** to every text field (search, filter, `Only in`, `Skip`, replace) that only appears while the field is hovered and has content.
* Recent-searches list: fixed entries being clipped/overlapped at the limit (flex rows no longer shrink; the list scrolls), the list no longer opens by itself on focus, and a freshly opened panel starts with an empty box and a closed history.

### Pinned searches

* New 📌 button that pins the current search — term, `Aa`/`.*`, scope, filter and the collapsed tree branches.
* Pins render in a scrollable box with a **drag handle** (resizable, height persisted), anchored at the **bottom** of the panel; each row shows the term with its parameters in muted text and a hover ✕.
* Clicking a pin restores the entire state and re-runs the search, including the fold state; duplicate pins move to the front instead of piling up.
* Persistence across sessions via `fastIndex.persistPinnedSearches` (workspace storage), toggleable in the panel settings.
* Pinning reveals the panel; the ☰ menu can show/hide the pinned box.

### Preview

* Added a docked **preview panel** (new view container in the bottom panel, next to the terminal).
* Preview follows the hovered result without swapping while the pointer travels to the pane; only a row the pointer still rests on is previewed (`fastIndex.previewHoverDelay`, default 1500 ms).
* `fastIndex.previewContextLines` (default 2) controls how many lines are shown above and below a match.
* The **search term itself** is highlighted inside the matched line; when a theme's find-highlight colour is nearly invisible against its background (e.g. Synthwave), the highlight is blended from the cursor colour plus an accent underline.
* Syntax highlighting for C/C++/C#/Python, driven by the **active theme's own `tokenColors`** (theme file resolution, `include` chains, JSONC parsing, scope mapping, transparent-colour guard) with built-in dark/light fallbacks.
* The panel preview is styled from the editor's theme variables — background, font family/size/weight, `editor.lineHeight`, line-number gutter, current-line highlight, selection, scrollbars — and clicking any line opens that file at that line.

### Results in the editor

* **Fast Index: Open Results in Editor** writes the results into a virtual document in **the exact format VS Code's own search editor uses**: `# Query:` / `# Flags:` / `# ContextLines:` directives, one `path/to/file.cpp:` block per file, `  12: code` for a match and `  12  code` for context.
* The document is labelled with the built-in **`search-result` language**, so VS Code's own `search-result` extension supplies everything else instead of this one re-implementing it:
  * its generated TextMate grammar opens a `meta.resultBlock` on each `file.ext:` line and *embeds that file's grammar* (`source.cpp`, `source.python`, `source.cs`, …) — so highlighting is done by the language extensions you have installed, not by a custom lexer;
  * its `DefinitionProvider` and `DocumentLinkProvider` turn paths and result lines into **Follow-link** targets;
  * its context/match line decorations give the familiar dimmed-context, bold-match look.
* A single click on a file or result line runs `editor.action.peekDefinition`, so the **peek opens inside the results tab** — it no longer jumps to the file and opens a peek there. The peek body is a real editor for the target file, so language-server features work in it.
* The panel still owns everything: one stable tab is rewritten in place on every new search (including replacements and Tree/List switches), so query, filters and context lines are always the panel's current ones — there are no controls inside the document.

### Follow-editor / prefill

* Opening the panel no longer restores or re-runs the previous query, and only an explicit **selection** seeds the box on open.
* While the panel is open, a cursor **on a word** (no ±1 probing) or a selection prefills the box; a cursor in whitespace does not.
* Opening or switching files no longer prefills (`TextEditorSelectionChangeKind.Command` is ignored; active-editor changes need a selection).
* Ignored prefills are logged with the reason (`locked`, `box-owned`) and prefills are tagged with their source.
* Restoring a pin claims the search box and suppresses editor prefills for 2.5 s.

### Reliability and plumbing

* **Latest search wins:** searches carry a generation number; a newer search cancels the running one between file batches and stale results are never posted.
* **Fast Index output channel** (`☰ → Show the search log`) recording every search with its trigger, scope, filter and result counts, plus prefill decisions and superseded searches.
* Title-bar buttons contributed through `menus."view/title"` (lock/unlock, settings, ☰ menu, results-in-editor) with a `fastIndex.locked` context key.
* The results preview panel is registered as `fast-index-preview-container` / `fast-index-preview` — view container ids must match `^[a-z0-9_-]+$`, which is why the original `fastIndex.previewPanel` id was silently rejected and the view fell back into the Explorer.
* Fixed a crash when opening the panel with the cursor at column 0 (`position.translate(0, -1)` threw "character must be non-negative").
* Fixed duplicate `viewsContainers` / `views` keys in `package.json`, which caused the panel view to be dropped from the manifest.

### Internal

* Split out `src/theme.ts` (theme token-colour resolution), `src/PreviewProvider.ts` (bottom-panel preview), `src/ResultsDocumentProvider.ts` (search-editor-format serialisation, depth-first ordering), `src/resultsView.ts` (results tab lifecycle, click-to-peek, panel-driven refresh) and `src/log.ts` (output channel).
* Pinned searches, lock state and layout stored through the webview/host state as appropriate.
