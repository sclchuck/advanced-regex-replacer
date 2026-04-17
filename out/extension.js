"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");
class RegexReplacerProvider {
    constructor(context) {
        this.context = context;
        this.targets = [];
        this.matches = [];
        this.searchRegex = null;
        this.replaceTemplate = "";
        this.includeActiveFile = true; // 默认选中
        this.isSearching = false; // 搜索状态
        this.abortController = null; // 取消控制器
        // UI 状态字段，用于恢复视图
        this.searchPattern = "";
        this.searchFlags = "g";
        this.previewOriginal = "";
        this.previewReplaced = "";
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();
        // 恢复完整状态（targets, matches, 输入框, preview）
        this.restoreViewState();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case "addFile":
                    await this.addTargets(true);
                    break;
                case "addFolder":
                    await this.addTargets(false);
                    break;
                case "removeTarget":
                    this.targets = this.targets.filter((t) => t.fsPath !== msg.fsPath);
                    this.postTargets();
                    break;
                case "toggleTarget": {
                    const t = this.targets.find((x) => x.fsPath === msg.fsPath);
                    if (t)
                        t.included = msg.checked;
                    break;
                }
                case "toggleActiveFile":
                    this.includeActiveFile = msg.checked;
                    break;
                case "search":
                    await this.doSearch(msg.regex, msg.flags, msg.replace);
                    break;
                case "cancelSearch":
                    this.cancelSearch();
                    break;
                case "replace":
                    await this.doReplace(msg.replace, msg.flags);
                    break;
                case "toggleMatch": {
                    const m = this.matches.find((x) => x.id === msg.id);
                    if (m)
                        m.checked = msg.checked;
                    break;
                }
                case "invertMatches":
                    this.invertMatches();
                    break;
                case "selectAllMatches":
                    this.setAllMatchesChecked(true);
                    break;
                case "unselectAllMatches":
                    this.setAllMatchesChecked(false);
                    break;
                case "openMatch": {
                    const match = this.matches.find((x) => x.id === msg.id);
                    if (match) {
                        const doc = await vscode.workspace.openTextDocument(match.fsPath);
                        const editor = await vscode.window.showTextDocument(doc);
                        editor.revealRange(match.range, vscode.TextEditorRevealType.InCenter);
                        editor.selection = new vscode.Selection(match.range.start, match.range.end);
                        const replaced = this.computeReplacementWithTemplate(match.groups, msg.replace || this.replaceTemplate, msg.flags || (this.searchRegex?.flags ?? ""));
                        // 保存 preview 状态用于恢复
                        this.previewOriginal = match.original;
                        this.previewReplaced = replaced;
                        this._view?.webview.postMessage({
                            command: "updatePreview",
                            original: this.previewOriginal,
                            replaced: this.previewReplaced,
                        });
                    }
                    break;
                }
            }
        });
    }
    restoreViewState() {
        this.postTargets();
        this.postMatches();
        this.postSearchStatus(this.isSearching);
        this._view?.webview.postMessage({
            command: "restoreInputs",
            regex: this.searchPattern,
            replace: this.replaceTemplate,
            flags: this.searchFlags,
        });
        this._view?.webview.postMessage({
            command: "updatePreview",
            original: this.previewOriginal,
            replaced: this.previewReplaced,
        });
    }
    async addTargets(isFile) {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: isFile,
            canSelectFolders: !isFile,
            openLabel: isFile
                ? vscode.l10n.t("ui.addFile")
                : vscode.l10n.t("ui.addFolder"),
        });
        if (!uris)
            return;
        for (const uri of uris) {
            if (!this.targets.some((t) => t.fsPath === uri.fsPath)) {
                this.targets.push({
                    fsPath: uri.fsPath,
                    isFolder: !isFile,
                    included: true,
                });
            }
        }
        this.postTargets();
    }
    getRelativePath(fsPath) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const root = workspaceFolders[0].uri.fsPath;
            const relPath = path.relative(root, fsPath);
            if (relPath === "") {
                return "./";
            }
            else if (relPath.startsWith("..")) {
                return relPath;
            }
            else {
                return `./${relPath.replace(/\\/g, "/")}`;
            }
        }
        return fsPath;
    }
    postTargets() {
        this._view?.webview.postMessage({
            command: "updateTargets",
            targets: this.targets.map((t) => ({
                ...t,
                displayPath: this.getRelativePath(t.fsPath),
            })),
            includeActiveFile: this.includeActiveFile,
        });
    }
    cancelSearch() {
        if (this.abortController) {
            this.abortController.abort();
            this.isSearching = false;
            this.postSearchStatus(false);
            vscode.window.showInformationMessage(vscode.l10n.t("msg.searchCanceled"));
        }
    }
    postSearchStatus(isSearching) {
        this._view?.webview.postMessage({
            command: "updateSearchStatus",
            isSearching,
        });
    }
    async doSearch(regexStr, flags, replaceStr) {
        if (this.isSearching) {
            vscode.window.showWarningMessage(vscode.l10n.t("msg.searchInProgress"));
            return;
        }
        // 保存 UI 状态用于恢复
        this.searchPattern = regexStr;
        this.searchFlags = flags;
        try {
            this.searchRegex = new RegExp(regexStr, flags);
        }
        catch (e) {
            vscode.window.showErrorMessage(vscode.l10n.t("msg.regexError", String(e)));
            return;
        }
        this.replaceTemplate = replaceStr;
        if (flags.includes("m")) {
            this.replaceTemplate = this.replaceTemplate.replace(/\\n/g, "\n");
        }
        this.matches = [];
        this.postMatches();
        let includedTargets = this.targets.filter((t) => t.included);
        if (this.includeActiveFile) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const activeFsPath = editor.document.uri.fsPath;
                if (!includedTargets.some((t) => t.fsPath === activeFsPath)) {
                    includedTargets.push({
                        fsPath: activeFsPath,
                        isFolder: false,
                        included: true,
                    });
                }
            }
        }
        this.isSearching = true;
        this.abortController = new AbortController();
        this.postSearchStatus(true);
        try {
            for (const t of includedTargets) {
                if (this.abortController.signal.aborted)
                    break;
                if (t.isFolder) {
                    await this.searchFolder(vscode.Uri.file(t.fsPath));
                }
                else {
                    await this.searchFile(vscode.Uri.file(t.fsPath));
                }
            }
            if (!this.abortController.signal.aborted) {
                vscode.window.showInformationMessage(vscode.l10n.t("msg.searchDone", this.matches.length));
            }
        }
        catch (e) {
            if (e?.name !== "AbortError") {
                vscode.window.showErrorMessage(vscode.l10n.t("msg.searchError", String(e)));
            }
        }
        finally {
            this.isSearching = false;
            this.abortController = null;
            this.postSearchStatus(false);
            this.postMatches();
        }
    }
    async searchFolder(folderUri) {
        if (this.abortController?.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
        }
        try {
            const entries = await fs.readdir(folderUri.fsPath, {
                withFileTypes: true,
            });
            if (this.abortController?.signal.aborted) {
                throw new DOMException("Aborted", "AbortError");
            }
            for (const entry of entries) {
                const childPath = path.join(folderUri.fsPath, entry.name);
                const childUri = vscode.Uri.file(childPath);
                if (entry.isDirectory() &&
                    (entry.name === "node_modules" ||
                        entry.name === ".git" ||
                        entry.name.startsWith("."))) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await this.searchFolder(childUri);
                }
                else if (entry.isFile()) {
                    await this.searchFile(childUri);
                }
            }
        }
        catch (e) {
            if (e?.name === "AbortError")
                throw e;
            console.warn(`Cannot read dir: ${folderUri.fsPath}`, e);
        }
    }
    async searchFile(fileUri) {
        if (this.abortController?.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
        }
        if (this.isLikelyBinary(fileUri.fsPath)) {
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const content = doc.getText();
            if (this.isBinaryContent(content)) {
                return;
            }
            let match;
            let idCounter = this.matches.length;
            while ((match = this.searchRegex.exec(content)) !== null) {
                if (this.abortController?.signal.aborted) {
                    throw new DOMException("Aborted", "AbortError");
                }
                const startPos = doc.positionAt(match.index);
                const endPos = doc.positionAt(match.index + match[0].length);
                const replaced = this.computeReplacement(match.slice(1));
                this.matches.push({
                    id: idCounter++,
                    fsPath: fileUri.fsPath,
                    line: startPos.line + 1,
                    original: match[0],
                    replaced,
                    range: new vscode.Range(startPos, endPos),
                    checked: true,
                    groups: match.slice(1),
                });
            }
        }
        catch (e) {
            if (e?.name === "AbortError")
                throw e;
            // Skip unreadable/binary-like files silently
        }
    }
    isLikelyBinary(fsPath) {
        const binaryExtensions = new Set([
            ".exe",
            ".dll",
            ".so",
            ".dylib",
            ".bin",
            ".obj",
            ".o",
            ".a",
            ".lib",
            ".zip",
            ".gz",
            ".tar",
            ".rar",
            ".7z",
            ".jar",
            ".war",
            ".ear",
            ".class",
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".bmp",
            ".ico",
            ".svgz",
            ".webp",
            ".avif",
            ".mp3",
            ".wav",
            ".mp4",
            ".avi",
            ".mov",
            ".mkv",
            ".flv",
            ".wmv",
            ".pdf",
            ".doc",
            ".docx",
            ".xls",
            ".xlsx",
            ".ppt",
            ".pptx",
            ".ttf",
            ".otf",
            ".woff",
            ".woff2",
            ".sqlite",
            ".db",
            ".mdb",
        ]);
        const ext = path.extname(fsPath).toLowerCase();
        return binaryExtensions.has(ext);
    }
    isBinaryContent(content) {
        if (content.length === 0)
            return false;
        let controlCharCount = 0;
        const limit = Math.min(content.length, 1024);
        for (let i = 0; i < limit; i++) {
            const code = content.charCodeAt(i);
            if ((code < 9 || (code > 10 && code < 32)) && code !== 127) {
                controlCharCount++;
            }
        }
        return controlCharCount / limit > 0.15;
    }
    computeReplacementWithTemplate(groups, replaceTemplate, flags = "") {
        let result = replaceTemplate;
        if (flags.includes("m")) {
            result = result.replace(/\\n/g, "\n");
        }
        result = result.replace(/\$\$\{([^}]+)\}\$\$/g, (_, expr) => {
            try {
                const safeX = [""];
                safeX.push(...groups);
                // NOTE: eval is powerful; keep this intentionally as your current behavior
                return eval(expr.replace(/x(\d+)/g, "safeX[$1]")).toString();
            }
            catch {
                return `[Eval Error]`;
            }
        });
        return result;
    }
    computeReplacement(groups) {
        return this.computeReplacementWithTemplate(groups, this.replaceTemplate, this.searchRegex?.flags ?? "");
    }
    invertMatches() {
        for (const m of this.matches) {
            m.checked = !m.checked;
        }
        this.postMatches();
    }
    setAllMatchesChecked(checked) {
        for (const m of this.matches) {
            m.checked = checked;
        }
        this.postMatches();
    }
    postMatches() {
        this._view?.webview.postMessage({
            command: "updateMatches",
            matches: this.matches.map((m) => ({
                id: m.id,
                fsPath: this.getRelativePath(m.fsPath),
                line: m.line,
                original: m.original.length > 256
                    ? m.original.slice(0, 253) + "..."
                    : m.original,
                replaced: m.replaced.length > 256
                    ? m.replaced.slice(0, 253) + "..."
                    : m.replaced,
                fullOriginal: m.original,
                checked: m.checked,
            })),
        });
    }
    async doReplace(replaceStr, flags) {
        if (typeof replaceStr === "string") {
            this.replaceTemplate = replaceStr;
        }
        const effectiveFlags = flags ?? (this.searchRegex?.flags ?? "");
        const toReplace = this.matches.filter((m) => m.checked);
        if (toReplace.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t("msg.noSelectedMatches"));
            return;
        }
        const byFile = {};
        for (const m of toReplace) {
            if (!byFile[m.fsPath])
                byFile[m.fsPath] = [];
            byFile[m.fsPath].push(m);
        }
        for (const fsPathStr in byFile) {
            const doc = await vscode.workspace.openTextDocument(fsPathStr);
            const edits = new vscode.WorkspaceEdit();
            byFile[fsPathStr].sort((a, b) => b.range.start.compareTo(a.range.start));
            for (const m of byFile[fsPathStr]) {
                const replaced = this.computeReplacementWithTemplate(m.groups, this.replaceTemplate, effectiveFlags);
                edits.replace(vscode.Uri.file(fsPathStr), m.range, replaced);
            }
            await vscode.workspace.applyEdit(edits);
            await doc.save();
        }
        vscode.window.showInformationMessage(vscode.l10n.t("msg.replacedCount", toReplace.length));
        this.matches = [];
        // 清空 preview 状态
        this.previewOriginal = "";
        this.previewReplaced = "";
        this.postMatches();
        this._view?.webview.postMessage({
            command: "updatePreview",
            original: "",
            replaced: "",
        });
    }
    addToScope(uri) {
        if (!this.targets.some((t) => t.fsPath === uri.fsPath)) {
            this.targets.push({
                fsPath: uri.fsPath,
                isFolder: false,
                included: true,
            });
            this.postTargets();
        }
    }
    getHtml() {
        const t = vscode.l10n.t;
        const I18N = {
            addFile: t("ui.addFile"),
            addFolder: t("ui.addFolder"),
            includeActive: t("ui.includeActiveFile"),
            scopeTitle: t("ui.scopeTitle"),
            binaryHint: t("ui.binaryHint"),
            regexLabel: t("ui.regexLabel"),
            regexPlaceholder: t("ui.regexPlaceholder"),
            replaceLabel: t("ui.replaceLabel"),
            replacePlaceholder: t("ui.replacePlaceholder"),
            flagIgnoreCase: t("ui.flagIgnoreCase"),
            flagMultiline: t("ui.flagMultiline"),
            flagDotAll: t("ui.flagDotAll"),
            searchBtn: t("ui.searchBtn"),
            replaceBtn: t("ui.replaceBtn"),
            matchesTitle: t("ui.matchesTitle"),
            searching: t("ui.searching"),
            cancel: t("ui.cancel"),
            invert: t("ui.invertMatches"),
            selectAll: t("ui.selectAll"),
            unselectAll: t("ui.unselectAll"),
            previewTitle: t("ui.previewTitle"),
            previewBefore: t("ui.previewBefore"),
            previewAfter: t("ui.previewAfter"),
        };
        const i18nJson = JSON.stringify(I18N);
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    button { padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .section { margin-bottom: 16px; }
    h3 { margin: 8px 0 4px; font-size: 13px; }
    input[type="text"] { width: 95%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
    .list-item { display: flex; align-items: center; padding: 2px 0; gap: 8px; }
    .list-item:hover { background: var(--vscode-list-hoverBackground); }
    .remove { color: #f66; cursor: pointer; font-weight: bold; }
    .match { cursor: pointer; }
    .preview { border-top: 1px solid var(--vscode-panel-border); padding-top: 0px; font-family: var(--vscode-editor-font-family); }
    .preview pre { background: var(--vscode-editor-background); padding: 4px; border: 1px solid var(--vscode-editor-lineHighlightBorder); overflow: auto; max-height: 200px; word-wrap: break-word; margin:0px; }
    #matches { max-height: 500px; overflow-y: auto; }
    .binary-hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; display: none; }

    .search-status {
      display: none;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
      margin-left: 8px;
    }
    .cancel-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 2px 8px;
      margin-left: 8px;
      font-size: 0.9em;
    }
    .cancel-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* 自定义 summary marker（三角） */
    details > summary {
      list-style: none;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    details > summary::-webkit-details-marker { display: none; }

    .summary-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-width: 0;
    }
    .summary-left {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .summary-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .arrow {
      width: 0;
      height: 0;
      border-left: 6px solid var(--vscode-foreground);
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      transition: transform 0.12s ease-in-out;
      flex: 0 0 auto;
    }
    details[open] .arrow { transform: rotate(90deg); }
  </style>
</head>
<body>
  <script>
    const I18N = ${i18nJson};
  </script>

  <div class="toolbar">
    <button id="add-file"></button>
    <button id="add-folder"></button>
    <label><input type="checkbox" id="include-active" checked> <span id="include-active-text"></span></label>
  </div>

  <div class="section">
    <h3 id="scope-title"></h3>
    <div id="targets"></div>
    <div class="binary-hint" id="binary-hint"></div>
  </div>

  <div class="section">
    <label id="regex-label"></label>
    <input id="regex" type="text" />
  </div>

  <div class="section">
    <label id="replace-label"></label>
    <input id="replace" type="text" />
  </div>

  <div class="section">
    <label><input type="checkbox" id="i" checked> <span id="flag-i"></span></label>
    <label><input type="checkbox" id="m" checked> <span id="flag-m"></span></label>
    <label><input type="checkbox" id="s"> <span id="flag-s"></span></label>
  </div>

  <div class="toolbar">
    <button id="search-btn" style="flex:1"></button>
    <button id="replace-btn" style="flex:1"></button>
  </div>

  <div class="section">
    <details open>
      <summary>
        <span class="arrow" aria-hidden="true"></span>
        <div class="summary-container">
          <div class="summary-left">
            <h3 style="display:inline"><span id="matches-title"></span> (<span id="count">0</span>)</h3>
          </div>
          <div class="summary-right">
            <button class="cancel-btn" id="select-all-matches"></button>
            <button class="cancel-btn" id="unselect-all-matches"></button>
            <button class="cancel-btn" id="invert-matches"></button>
            <span class="search-status" id="search-status"></span>
            <button class="cancel-btn" id="cancel-search" style="display:none"></button>
          </div>
        </div>
      </summary>
      <div id="matches"></div>
    </details>
  </div>

  <div class="preview">
    <h3 id="preview-title"></h3>
    <strong id="preview-before"></strong><pre id="before"></pre>
    <strong id="preview-after"></strong><pre id="after"></pre>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const savedState = vscode.getState() || {};

    // i18n render
    document.getElementById('add-file').textContent = I18N.addFile;
    document.getElementById('add-folder').textContent = I18N.addFolder;
    document.getElementById('include-active-text').textContent = I18N.includeActive;

    document.getElementById('scope-title').textContent = I18N.scopeTitle;
    document.getElementById('binary-hint').textContent = I18N.binaryHint;

    document.getElementById('regex-label').textContent = I18N.regexLabel;
    document.getElementById('regex').placeholder = I18N.regexPlaceholder;

    document.getElementById('replace-label').textContent = I18N.replaceLabel;
    document.getElementById('replace').placeholder = I18N.replacePlaceholder;

    document.getElementById('flag-i').textContent = I18N.flagIgnoreCase;
    document.getElementById('flag-m').textContent = I18N.flagMultiline;
    document.getElementById('flag-s').textContent = I18N.flagDotAll;

    document.getElementById('search-btn').textContent = I18N.searchBtn;
    document.getElementById('replace-btn').textContent = I18N.replaceBtn;

    document.getElementById('matches-title').textContent = I18N.matchesTitle;
    document.getElementById('search-status').textContent = I18N.searching;
    document.getElementById('cancel-search').textContent = I18N.cancel;
    document.getElementById('select-all-matches').textContent = I18N.selectAll;
    document.getElementById('unselect-all-matches').textContent = I18N.unselectAll;
    document.getElementById('invert-matches').textContent = I18N.invert;

    document.getElementById('preview-title').textContent = I18N.previewTitle;
    document.getElementById('preview-before').textContent = I18N.previewBefore;
    document.getElementById('preview-after').textContent = I18N.previewAfter;

    // 从本地状态恢复输入框内容
    if (savedState.regex) document.getElementById('regex').value = savedState.regex;
    if (savedState.replace) document.getElementById('replace').value = savedState.replace;
    if (savedState.flags) {
      document.getElementById('i').checked = savedState.flags.includes('i');
      document.getElementById('m').checked = savedState.flags.includes('m');
      document.getElementById('s').checked = savedState.flags.includes('s');
    }
    if (savedState.previewOriginal !== undefined) {
      document.getElementById('before').textContent = savedState.previewOriginal;
    }
    if (savedState.previewReplaced !== undefined) {
      document.getElementById('after').textContent = savedState.previewReplaced;
    }

    // 保存 UI 状态到本地存储
    function saveUiState() {
      let flags = 'g';
      if (document.getElementById('i').checked) flags += 'i';
      if (document.getElementById('m').checked) flags += 'm';
      if (document.getElementById('s').checked) flags += 's';

      vscode.setState({
        regex: document.getElementById('regex').value,
        replace: document.getElementById('replace').value,
        flags,
        previewOriginal: document.getElementById('before').textContent,
        previewReplaced: document.getElementById('after').textContent,
      });
    }

    // 监听输入框变化并保存状态
    document.getElementById('regex').addEventListener('input', saveUiState);
    document.getElementById('replace').addEventListener('input', saveUiState);
    document.getElementById('i').addEventListener('change', saveUiState);
    document.getElementById('m').addEventListener('change', saveUiState);
    document.getElementById('s').addEventListener('change', saveUiState);

    // Update targets
    function updateTargets(targets, includeActiveFile) {
      document.getElementById('include-active').checked = includeActiveFile;
      const container = document.getElementById('targets');
      container.innerHTML = '';
      targets.forEach(t => {
        const div = document.createElement('div');
        div.className = 'list-item';

        let displayPath = t.displayPath;
        if (displayPath && !displayPath.startsWith('./') && !displayPath.startsWith('/') && !displayPath.includes(':')) {
          displayPath = './' + displayPath;
        }

        div.innerHTML = \`
          <input type="checkbox" \${t.included ? 'checked' : ''}>
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis;">\${displayPath}</span>
          <span class="remove">×</span>
        \`;

        div.querySelector('input').onchange = e =>
          vscode.postMessage({command:'toggleTarget', fsPath:t.fsPath, checked:e.target.checked});
        div.querySelector('.remove').onclick = () =>
          vscode.postMessage({command:'removeTarget', fsPath:t.fsPath});
        container.appendChild(div);
      });

      if (targets.length > 0) {
        document.getElementById('binary-hint').style.display = 'block';
      } else {
        document.getElementById('binary-hint').style.display = 'none';
      }
    }

    // Update matches
    function updateMatches(matches) {
      document.getElementById('count').textContent = matches.length;
      document.getElementById('select-all-matches').disabled = matches.length === 0;
      document.getElementById('unselect-all-matches').disabled = matches.length === 0;
      document.getElementById('invert-matches').disabled = matches.length === 0;
      const container = document.getElementById('matches');
      container.innerHTML = '';
      matches.forEach(m => {
        const div = document.createElement('div');
        div.className = 'list-item match';

        let fsPath = m.fsPath;
        if (fsPath && !fsPath.startsWith('./') && !fsPath.startsWith('/') && !fsPath.includes(':')) {
          fsPath = './' + fsPath;
        }

        div.innerHTML = \`
          <input type="checkbox" \${m.checked ? 'checked' : ''}>
          <span style="flex:1">\${fsPath}:\${m.line}</span>
        \`;

        div.querySelector('input').onchange = e =>
          vscode.postMessage({command:'toggleMatch', id:m.id, checked:e.target.checked});

        div.onclick = (e) => {
          if (e.target.type !== 'checkbox') {
            const replace = document.getElementById('replace').value;

            let flags = '';
            if (document.getElementById('i').checked) flags += 'i';
            if (document.getElementById('m').checked) flags += 'm';
            if (document.getElementById('s').checked) flags += 's';
            flags += 'g';

            vscode.postMessage({
              command: 'openMatch',
              id: m.id,
              replace,
              flags
            });
            document.getElementById('before').textContent = m.fullOriginal;
          }
        };

        container.appendChild(div);
      });
    }

    // Update search status
    function updateSearchStatus(isSearching) {
      const statusEl = document.getElementById('search-status');
      const cancelBtn = document.getElementById('cancel-search');
      const searchBtn = document.getElementById('search-btn');

      if (isSearching) {
        statusEl.style.display = 'inline-block';
        cancelBtn.style.display = 'inline-block';
        searchBtn.disabled = true;
      } else {
        statusEl.style.display = 'none';
        cancelBtn.style.display = 'none';
        searchBtn.disabled = false;
      }
    }

    // Buttons
    document.getElementById('add-file').onclick = () => vscode.postMessage({command:'addFile'});
    document.getElementById('add-folder').onclick = () => vscode.postMessage({command:'addFolder'});
    document.getElementById('include-active').onchange = e =>
      vscode.postMessage({command:'toggleActiveFile', checked:e.target.checked});

    document.getElementById('search-btn').onclick = () => {
      const regex = document.getElementById('regex').value;
      const replace = document.getElementById('replace').value;

      let flags = '';
      if (document.getElementById('i').checked) flags += 'i';
      if (document.getElementById('m').checked) flags += 'm';
      if (document.getElementById('s').checked) flags += 's';
      flags += 'g';

      vscode.postMessage({command:'search', regex, flags, replace});
    };

    document.getElementById('replace-btn').onclick = () => {
      const replace = document.getElementById('replace').value;

      let flags = '';
      if (document.getElementById('i').checked) flags += 'i';
      if (document.getElementById('m').checked) flags += 'm';
      if (document.getElementById('s').checked) flags += 's';
      flags += 'g';

      vscode.postMessage({
        command: 'replace',
        replace,
        flags
      });
    };
    document.getElementById('cancel-search').onclick = () => vscode.postMessage({command:'cancelSearch'});
    document.getElementById('select-all-matches').onclick = () => vscode.postMessage({command:'selectAllMatches'});
    document.getElementById('unselect-all-matches').onclick = () => vscode.postMessage({command:'unselectAllMatches'});
    document.getElementById('invert-matches').onclick = () => vscode.postMessage({command:'invertMatches'});

    // Receive messages
    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.command === 'updateTargets') updateTargets(msg.targets, msg.includeActiveFile);
      if (msg.command === 'updateMatches') updateMatches(msg.matches);
      if (msg.command === 'updateSearchStatus') updateSearchStatus(msg.isSearching);
      if (msg.command === 'updatePreview') {
        document.getElementById('before').textContent = msg.original;
        document.getElementById('after').textContent = msg.replaced;
        saveUiState();
      }
      if (msg.command === 'restoreInputs') {
        document.getElementById('regex').value = msg.regex || '';
        document.getElementById('replace').value = msg.replace || '';
        const flags = msg.flags || 'g';
        document.getElementById('i').checked = flags.includes('i');
        document.getElementById('m').checked = flags.includes('m');
        document.getElementById('s').checked = flags.includes('s');
        saveUiState();
      }
    });
  </script>
</body>
</html>`;
    }
}
function activate(context) {
    const provider = new RegexReplacerProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("regexReplacer.view", provider, {
        webviewOptions: {
            retainContextWhenHidden: true,
        },
    }));
    context.subscriptions.push(vscode.commands.registerCommand("regexReplacer.addToScope", (uri) => {
        provider.addToScope(uri);
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map