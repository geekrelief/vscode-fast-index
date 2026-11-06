# Fast Project Indexer ⚡️

**Fast Project Indexer** is a VS Code extension that brings instant, JetBrains-style full-text search and replace functionality to your workspace.

Instead of searching text "on the fly" for every query, the plugin builds an inverted trigram index in the background once, providing instantaneous search results even in massive codebases.

## Key Features

* **Instant Search:** Results appear as you type (from 3 characters) with zero lag. The search box takes focus when the panel opens and doubles as an **editable combo box**: the ▾ caret sits *inside* the field, where there used to be a separate button — click it (or press `Alt+↓`) for every recent search, press `↓`/`↑` to walk them, and typing filters the open list. `Enter` runs the highlighted entry, `Esc` closes it. The list size is `fastIndex.maxRecentSearches` (default 20, 0 disables it).
* **No surprise prefills:** opening the panel never restores the previous query. It seeds the box from an explicit **selection**, or from a caret **you** placed (clicking a word, or typing) — never from the caret a file open leaves at 0,0. While the panel is open, clicking onto a word (or selecting text) keeps the box in sync, and the box stops being "yours" as soon as focus returns to the editor. Toggle the whole behavior with `fastIndex.followEditor` (or the checkbox in the panel settings), or freeze it temporarily with the 🔒 title-bar lock.
* **Replace keeps the index current:** applying a replacement re-indexes the affected buffers immediately, and searching reads open (dirty) documents, so replaced text disappears from results and new text is findable without saving first.
* **Results in the editor:** the book icon in the title bar (**Fast Index: Open Results in Editor**) opens the current results as a real editor tab, written in VS Code's own search-editor format so the built-in `search-result` language gives it theme-driven syntax highlighting, Follow-link targets and peek-on-click. It is driven by the panel and refreshed in place. Set `fastIndex.autoOpenResults` to have it open itself after a search.
* **Results follow into the results editor:** resting the pointer on a match, or selecting it, scrolls the results tab to that exact hit and **selects that line**, so the indicator is a normal text selection that stays until you pick another match. The match's **file row and every ancestor directory are highlighted** in the tree at the same time — the same emphasis the Explorer gives the active file — and the highlight follows the pointer to another file. It never takes focus and never refills the search box (selections made in the results editor are ignored by Auto Search unless you turn on `fastIndex.autoSearchFromResults`). If the tab is closed or hidden nothing happens.
* **Balanced results:** at most `fastIndex.maxResultsPerFile` matching lines per file (default 3, 0 = unlimited) and a fair share of the result list per workspace folder, so one huge engine file can no longer hide your own project's hits.
* **Title-bar buttons:** the 🔒/🔓 lock, ⚙️ settings and ☰ menu sit in the view's title bar next to the name, like the built-in Search view. The ⚙️ button now brings the **Settings** section into view (its own section at the bottom of the Fast Index container, under Pinned Searches). The 🔒 **lock** freezes the search — clicking or moving the cursor in the editor no longer refills the query, so results stay put while you read code; the state survives reloads (a **🔒 Locked** badge in the results toolbar shows when a lock is in force). The ☰ menu offers pinned-search show/hide, the results editor and the search log.
* **⚡ editor title button:** every editor shows the same zap icon as the view container; clicking it brings the Fast Index panel forward. That is what gets you back to the panel after the container has been moved to the **Secondary Side Bar**, where the Activity Bar icon is gone.
* **Pinned searches:** the 📌 button saves the current search — term, `Aa`/`.*`, `Only in`, `Skip`, the results filter and your collapsed tree branches. Pins live in their own collapsible **Pinned Searches** section in the Fast Index container, so they can never overlap the results; each row shows the term with its parameters (`only: h · Aa`) in the description. Click one to restore the whole state, or right-click for **Remove Pinned Search**. Kept per workspace and across sessions by `fastIndex.persistPinnedSearches` (default on; turn it off — or untick it in the panel settings — to keep pins for the session only).
* **Search log:** the ☰ menu's *Show the search log* opens a **Fast Index** output panel that records every search with its trigger (typing, pin, filter, scope, prefill…), its scope/filter and the result counts, plus prefills that were ignored and why, and searches superseded by a newer one. Use it when results change unexpectedly.
* **Latest search wins:** starting a search cancels the one in flight; stale results are discarded instead of overwriting the newer list.
* **Search scope:** Two boxes under the search input narrow any query without reindexing. `Only in` and `Skip` accept comma-separated tokens that match **partially**: an extension (`cpp`, `cp`, `h`), a file or folder fragment (`Char`, `Game`, `Source/Game`), or an exact suffix (`.h`, `*.ini`). Examples: only C++ sources → `cpp`; headers → `h` or `.h`; only Python → `py`; one directory → `Source/Game`; skip build output → `Intermediate, Test`.
* **Filename matches first:** Files whose *name* matches the query are listed above content-only matches — exact name matches first, then prefix matches, then partial ones, then path-qualified queries (`GameFramework/Character.h`). A file whose name matches but whose content never mentions the query is still listed, marked `file name match`.
* **Native results tree:** results are a real VS Code **TreeView** (`fast-index.results`) grouped by directory then by file, with one row per match. Because VS Code renders it, everything is native: click to expand or collapse, keyboard navigation, the tree's own find widget, file icons, **Collapse All** in the view title, and **sticky scroll** (`workbench.tree.enableStickyScroll`) — including compressed overflow rows and collapsing a folder straight from a pinned row. Selecting a match scrolls the results editor to it; clicking one opens the file at that line.
* **Filter results:** The box directly under the search field is a boolean modifier of the search — a row must match both the query and the filter (by file name or line text). It survives new searches, `Only in` / `Skip` edits and result refreshes, and clearing it re-runs the query. Every text field shows a ✕ on hover to clear it.
* **Trigram Indexing:** Searches not just by whole words, but by word parts (e.g., `calc` will find `calculateTotalPrice`).
* **Find & Replace:** replace across multiple files or one at a time. The **Replace** toggle now sits in the view's title bar and reveals the *Replace with…* field at the bottom of the controls, under *Skip*, together with **Replace All** — everything is hidden again when you toggle it off. A single match is replaced from the results tree's context menu — **Replace This Match…** prompts for the text and remembers the last value used. Multiline snippets are supported and every edit goes through `WorkspaceEdit`, so Ctrl+Z undoes it.
* **Advanced Matching:** Toggle Case-Sensitive (`Aa`) matching or Regular Expressions (`.*`) right from the search bar.
* **Native Sidebar Integration:** A dedicated activity bar icon ⚡️ ensures the search doesn't clutter your built-in tools. Keeps its state even when you switch tabs.
* **Multithreading:** Heavy file parsing is offloaded to background OS threads. Your VS Code UI won't freeze during indexing.
* **Disk Caching & Live Updates:** The index is saved locally and instantly loads upon restart. Live file watchers keep the index accurate as you code.

## How to Use

1. Open your project in VS Code.
2. Click on the **Lightning Bolt (⚡️)** icon in the Activity Bar on the left.
3. If it's your first time, the plugin will ask to build the index. You can also click the **⚙️** title-bar button and press **Reindex** (settings save themselves as you edit).
4. Start typing (at least 3 characters) — results with code highlighting will appear instantly. Click on a result to jump directly to the matched line.
5. Click **▼ Replace** to open the replace panel. Hover over a result and click `Replace` for a surgical fix, or use `Replace All`.
6. Use the `Aa` or `.*` toggles in the search input to use case-sensitive or RegEx searches.
7. Press 📌 to pin the current search, or the book icon to open the results as a real editor tab.

## Configuration

You can customize the extension directly via the **⚙️** title-bar button. The panel is split into three bordered groups — **Search Settings**, **Indexing** and **Cached indexes** — so it is obvious which controls change the index and which only change how searching behaves. Every field is applied as you edit it — there is no Save button: text and number fields save after a short pause (or immediately on `Enter`), checkboxes save the moment you toggle them.

Three of these settings shape the index itself: **Include Extensions**, **Exclude Patterns** and **Max File Size**. Editing them cannot change the index that already exists, so the panel shows a **stale-index banner** naming the changed fields, with an **Undo changes** button that restores the values the current index was built with. **Reindex** commits them. If you leave the settings view or close the panel with such a change still pending, a confirmation asks whether to **Reindex now**, **Reject changes** or **Keep for now** (asking only once per distinct set of values).

* **Include Extensions:** Limit indexing to specific file types (e.g., `ts,js,md`). Leave empty to index everything.
* **Exclude Patterns:** Glob patterns for files/folders to ignore (e.g., `{**/node_modules/**,**/.git/**}`).
* **Max File Size (KB):** Prevent the indexer from choking on huge minified or binary files (default is `512` KB).
* **Max Search Results:** Limit the number of snippets shown to keep the UI responsive (default is `50`).
* **Show the hit's context line under each result:** on/off (default on, also `fastIndex.showContextLine`). Turn it off for a compact file-and-line list; the list re-renders as soon as you toggle it.
* **Panel Font Size (px):** Text size for the panel — search results, pinned searches, buttons — default `14`, range `9`–`24`. Everything in the panel scales from it, and the change is visible as you type.
* **Hover jump timing** follows VS Code's own `workbench.hover.delay`; the extension no longer has a delay setting of its own.
* **Results Context Lines:** Lines shown above and below each match in the results editor (default `2`).
* **Hover Highlight Color:** which theme color marks the hovered result's line, its file and its folders in the results tree — theme chart **yellow** by default, or the list highlight / chart blue, green, orange, purple, red, or the info foreground. Also `fastIndex.hoverHighlightColor`.
* **Keep pinned searches between sessions:** on/off (default on).
* **Open the results editor automatically:** on/off (default off, also `fastIndex.autoOpenResults`). When on, a search that finds matches reopens the results tab if you closed it — without stealing focus, so you can keep typing in the panel.
* **Auto Search: Follows text editor cursor and selection:** on/off.
* **Auto Search from the results window:** on/off (default off, also `fastIndex.autoSearchFromResults`). Off means selecting a line in the results editor never disturbs your query; on means that selection fills the search box like an editor selection would.
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

The results tab is a real editor, so its highlighting is the editor's own: no theme parsing or token mapping lives in this extension any more.

## Changelog

### 0.8.0 → 0.21.3 — native results tree, hover jump, pinned section, settings section, results editor and settings fixes

#### Results tab in the editor

* **Fast Index: Open Results in Editor** writes the results into a virtual document in **the exact format VS Code's own search editor uses**: `# Query:` / `# Flags:` / `# ContextLines:` directives, one `path/to/file.cpp:` block per file, `  12: code` for a match and `  12  code` for context.
* The document is labelled with the built-in **`search-result` language**, so VS Code's own `search-result` extension supplies everything else instead of this one re-implementing it:
  * its generated TextMate grammar opens a `meta.resultBlock` on each `file.ext:` line and *embeds that file's grammar* (`source.cpp`, `source.python`, `source.cs`, …) — highlighting is done by the language extensions you have installed, not by a custom lexer;
  * its `DefinitionProvider` and `DocumentLinkProvider` turn paths and result lines into **Follow-link** targets;
  * its context/match line decorations give the familiar dimmed-context, bold-match look.
* A single click on a file or result line runs `editor.action.peekDefinition`, so the **peek opens inside the results tab** rather than jumping to the file and peeking there. The peek body is a real editor for the target file, so language-server features work in it.
* The panel still owns everything: one stable tab is rewritten in place on every new search (including replacements and Tree/List switches), so query, filters and context lines are always the panel's current ones — there are no controls inside the document.
* New **`fastIndex.autoOpenResults`** (default off): a search that finds matches reopens the tab if it was closed, with `preserveFocus` so the search box keeps the keyboard. Closing that tab is treated as deliberate — by mouse or by shortcut, it took an explicit action — so the next result-bearing search opens it again.
* "Is the tab open?" is now judged from the tab strip (`window.tabGroups`), not from loaded documents: a closed virtual document stays loaded in memory, which previously made the tab stop auto-opening after a few searches while the panel kept updating.
* Resting the pointer on a result scrolls that tab to the hit (timing is VS Code's `workbench.hover.delay`) and **selects that line**; the selection stays until another result is hovered, takes no focus, and is cleared when a new search rewrites the document.

#### Removed: both previews

* The **inline sidebar preview** is gone: `fastIndex.inlinePreview`, its ⚙️ checkbox, its ☰ toggle, the pane markup/CSS and the C/C++/C#/Python tokenizer that fed it.
* The **bottom-panel preview is gone too**: `PreviewProvider`, `theme.ts`, `media/preview.svg`, the `fast-index-preview-container` view and the *Fast Index: Open Preview Panel* command. A webview cannot host a real editor, so it could never match the editor's look (no semantic tokens, indent guides, folding, ligatures or the real fonts); hovering the real results editor replaced it.
* The ☰ menu now offers the results editor where the preview used to be.

#### Prefill

* Opening the panel seeds the box from an explicit **selection** or from a caret the user placed (clicked or typed); a caret left by opening a file still does not count.
* The caret mark and the editor listeners now live for the **whole extension lifetime** instead of inside `resolveWebviewView`: a click made before the panel has ever been opened in that window is remembered, so the first open seeds the box (previously it took a second click).
* The box counts as user-owned only while the panel has focus, so returning to the editor lets the caret drive the search again even when no `blur` event arrives.
* A **persisted 🔒 lock** used to disable prefill silently — no message, no log line. The results toolbar now shows a **🔒 Locked** badge, and the output channel logs the reason once per lock.

#### Settings section (0.20.0)

* Settings is now **its own section** at the bottom of the Fast Index container, under Pinned Searches, instead of a panel toggled inside the search view. It is a webview view that renders the same form (one shared markup and stylesheet), so every field, the Reindex button, the stale banner and the cached-indexes list behave exactly as before; the section is collapsible like any other, and the ⚙️ title-bar button **focuses** it (`fast-index.settings.focus`). It deliberately does not hide the pane: hiding makes the workbench re-add it at its default height, so the section heights and collapsed state you set — which VS Code persists itself in `views.customizations`, at application scope — would be lost. Collapse or resize sections with their own chevrons and drag handles; that layout survives reloads, workspaces and the gear button.
* The search panel no longer renders the form at all — the markup, the save logic and the cache list were **removed** from it, not just hidden, so opening the container shows Search, Results, Pinned Searches, Settings.
* Messages from both webviews go through one handler and replies are broadcast to both, so saving a setting updates the section and the panel alike.

#### Settings

* The panel is grouped into bordered sections — **Search Settings** (result limit, recent searches, hover jump, context lines and the behavior toggles, including the renamed *Auto Search: Follows text editor cursor and selection*), **Indexing** (include extensions, exclude patterns, max file size, Reindex and the stale banner) and **Cached indexes** — so index-shaping controls are never mixed in with search controls.
* Every settings field applies **as you edit it**: text and number fields debounce ~350 ms (or flush immediately on `Enter`), checkboxes apply at once. There is no Save button to forget.
* **Save & Reindex** is now just **Reindex**. Index-affecting edits (include extensions, exclude patterns, max file size) no longer rebuild the index behind your back while you type.
* The panel tracks what the last successful build actually consumed, so it can say the index is **stale** rather than guessing: a banner names the changed fields and offers **Undo changes** to restore the indexed values, next to **Reindex**.
* Leaving the settings view or hiding the panel with a pending index change asks **Reindex now / Reject changes / Keep for now**; it asks once per distinct set of values, so "Keep for now" does not nag on every panel hide.
* Removed **`fastIndex.hoverJumpDelay`**: with the native tree the hover is resolved by VS Code, so its timing is `workbench.hover.delay` and an extra delay setting was redundant.
* `fastIndex.previewContextLines` → **`fastIndex.resultContextLines`**.
* New **`fastIndex.autoOpenResults`** (default off).
* New **`fastIndex.panelFontSize`** (default 14 px, range 9–24): the webview's root font size, so search results, pinned searches and buttons all scale together. The panel is rendered with it and resizes as you type.
* New **`fastIndex.showContextLine`** (default on): whether each result in the panel shows the matched line of code under its file name. Toggling it re-renders the current results immediately.
* File names are bold in both the tree and the flat list, while directory nodes are semi-bold (600) so the two levels stay distinguishable.
* New **`fastIndex.autoSearchFromResults`** (default off): whether selecting a line in the results editor may fill the search box. The webview now also receives all settings when it becomes ready, so `hoverJumpDelay` (and the rest) apply immediately instead of waiting for the settings panel to be opened.
* All of them relabelled in the panel's ⚙️ settings.

#### Panel results

* **The results are a native tree view now.** They moved out of the webview into a contributed `TreeView` (`fast-index.results`), so VS Code owns expansion, keyboard navigation, find, icons, **Collapse All** and **sticky scroll** (`workbench.tree.enableStickyScroll`, applied by `workbenchTreeDataPreamble` to every workbench tree, extension-contributed ones included). Sticky rows are real tree rows, so a pinned folder collapses when clicked, and a deep path is compressed by `CompressibleStickyScrollDelegate` exactly as in the Explorer.
* **Replace moved to the context menu.** The per-row inline Replace button is gone; right-clicking a match offers **Replace This Match…**, which prompts for the replacement (prefilled with the last value used) and then refreshes the tree and the results editor.
* The webview still owns the search box, filter, scope fields and settings; its results area is no longer rendered.
* **Pinned Searches is its own collapsible section** (`fast-index.pins`), so pins can no longer overlap the results. Click a pin to restore it; right-click to **Remove Pinned Search**.
* **Hover coloring.** Hovering a match colors its file row and every ancestor directory through a **file decoration** (`FileDecoration.color = list.highlightForeground`), which is the only tree API that actually paints a row; `TreeItemLabel.highlights` only emboldens, which bold theme fonts swallow. Rows carry a private `fast-index:` URI so the tint never leaks into the Explorer. The color moves with the pointer and clears behind it, and only the rows whose color changed are refreshed, deferred by a tick because `onDidChangeTreeData` must not fire inside `resolveTreeItem`. That is the closest a `TreeView` gets to the Explorer's active-file styling: row backgrounds are not settable by the API, only the label emphasis (or a `FileDecorationProvider`, which would tint the file in the Explorer too).
* **Hover jump works through `resolveTreeItem`.** A `TreeView` has no hover event, but VS Code calls the provider's `resolveTreeItem(item, element)` *when the pointer rests on a row*, because the row's `tooltip` is left undefined and the contract says it is "called on hover to resolve the tooltip if it is undefined". Match rows now never return a tooltip — the popup over the results was pure noise — so the call is used purely as the hover signal that jumps the results editor. VS Code memoises that resolution per row, so the provider refreshes just that row (element-scoped, ~300 ms later and throttled to once a second) to clear the cache and let the next hover fire again; the provider implements `getParent` so VS Code can walk from the row to its parent for that scoped refresh. Folder and file rows keep eager tooltips and never trigger it. Timing is `workbench.hover.delay`; selecting a match still jumps as well.
* Directory rows carry **no icon** — the tree is a result list, not a file browser. File names are **bold**; directory nodes are semi-bold (600) so the two levels stay distinguishable.
* New **`fastIndex.showContextLine`** toggle to hide the matched line under each result for a compact file-and-line list.

#### Section layout (0.21.3)

* **The status moved into the view title bar.** `WebviewView.description` renders next to "Fast Index Search", so the panel no longer spends a row on it: the index state reads `Loading index…`, `1,234 files` (the `Ready · ` prefix is dropped) or `Not indexed yet`, whitespace collapsed and capped at 60 characters. Nothing else in the panel changed size.

* **The search panel can no longer hide its own fields.** When the sections below squeeze its pane, the panel body now scrolls (`overflow-y: auto`, content sized to its own height instead of being flex-shrunk), so *Skip*, *Only in*, the replace field and Replace All stay reachable instead of being clipped — and focusing a field scrolls it into view. The pane height itself is the workbench splitview's, which the extension cannot clamp.

* Section heights, border positions and collapsed state are **workbench-owned**: VS Code stores them per view in `views.customizations` at application scope (`ViewDescriptorService`), so they persist across sessions and workspaces without the extension doing anything.
* The extension API has no way to set a view's size or collapsed state, so the only code that could destroy that layout is our own. The ⚙️ button therefore **focuses** the Settings section instead of hiding it — `toggleVisibility` was removed, because re-showing a hidden pane puts it back at its default height.
* `fast-index.results` keeps its own expansion state per workspace through stable `TreeItem.id`s, so a collapsed directory stays collapsed after a reload.

#### Panel controls (0.18.0)

* **Replace moved to the title bar.** The in-panel Replace button is gone; a `$(replace)` button in the view title toggles replace mode, which shows the *Replace with…* field under *Skip* plus Replace All.
* **Settings no longer trap you.** Opening the settings switches the panel body to scrollable (`body.settings-open`), expands it to its content height and scrolls the settings into view, so every group is reachable even when the results section below is tall.
* **`fastIndex.hoverHighlightColor`** picks the theme color used for the hover highlight (default `charts.yellow`), both as a setting and as a themed dropdown in the panel settings. Colour is applied as a file decoration, and only the rows whose decoration actually changes are repainted — the tree itself is never refreshed, so rows no longer flash their undecorated color first.

#### Panel access

* New **⚡ button in the editor title bar**, using the same `$(zap)` icon as the view container. It focuses the Fast Index view, which also re-reveals its container after it has been dragged to the **Secondary Side Bar** (where no Activity Bar icon exists). On hosts without the per-view command it falls back to `workbench.view.extension.fast-index-explorer`.

#### Build hygiene

* `npm run clean` deletes `out/` and runs before `compile` and `vscode:prepublish`: `tsc` never deletes outputs for deleted sources, so 0.10.0 still shipped `PreviewProvider.js`, `syntax.js` and `theme.js`.

#### Internal

* Split the results tab into `src/ResultsDocumentProvider.ts` (search-editor serialization, hover line map, depth-first ordering) and `src/resultsView.ts` (tab lifecycle, click-to-peek, hover reveal, panel-driven refresh).

### 0.3.6 → 0.7.5 — search UI, pins, diagnostics

#### Search UI

* Moved **Filter these results** directly under the search field, matching its styling (`.input-group`), and made it a **boolean modifier of the search**: a row must match both the query and the filter, applied host-side so the scan keeps going until it has enough matching rows.
* The filter now survives new searches, `Only in` / `Skip` edits and result refreshes; clearing it re-runs the query.
* Added a **✕ clear button** to every text field (search, filter, `Only in`, `Skip`, replace) that only appears while the field is hovered and has content.
* Recent-searches list: fixed entries being clipped/overlapped at the limit (flex rows no longer shrink; the list scrolls), the list no longer opens by itself on focus, and a freshly opened panel starts with an empty box and a closed history.

#### Pinned searches

* New 📌 button that pins the current search — term, `Aa`/`.*`, scope, filter and the collapsed tree branches.
* Pins render in a scrollable box with a **drag handle** (resizable, height persisted), anchored at the **bottom** of the panel; each row shows the term with its parameters in muted text and a hover ✕.
* Clicking a pin restores the entire state and re-runs the search, including the fold state; duplicate pins move to the front instead of piling up.
* Persistence across sessions via `fastIndex.persistPinnedSearches` (workspace storage), toggleable in the panel settings.
* Pinning reveals the panel; the ☰ menu can show/hide the pinned box.

#### Follow-editor / prefill

* While the panel is open, a cursor **on a word** (no ±1 probing) or a selection prefills the box; a cursor in whitespace does not.
* Opening or switching files no longer prefills (`TextEditorSelectionChangeKind.Command` is ignored; active-editor changes need a selection).
* Ignored prefills are logged with the reason (`locked`, `box-owned`) and prefills are tagged with their source.
* Restoring a pin claims the search box and suppresses editor prefills for 2.5 s.

#### Reliability and plumbing

* **Latest search wins:** searches carry a generation number; a newer search cancels the running one between file batches and stale results are never posted.
* **Fast Index output channel** (`☰ → Show the search log`) recording every search with its trigger, scope, filter and result counts, plus prefill decisions and superseded searches.
* Title-bar buttons contributed through `menus."view/title"` (lock/unlock, settings, ☰ menu, results-in-editor) with a `fastIndex.locked` context key.
* Fixed a crash when opening the panel with the cursor at column 0 (`position.translate(0, -1)` threw "character must be non-negative").
* Fixed duplicate `viewsContainers` / `views` keys in `package.json`, which caused the panel view to be dropped from the manifest.

#### Internal

* Pinned searches, lock state and layout stored through the webview/host state as appropriate.

