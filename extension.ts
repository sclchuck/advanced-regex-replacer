import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

interface Target {
  fsPath: string;
  isFolder: boolean;
  included: boolean;
}

interface Match {
  id: number;
  fsPath: string;
  line: number;
  original: string;
  replaced: string;
  range: vscode.Range;
  checked: boolean;
  groups: string[];
}

class RegexReplacerProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private targets: Target[] = [];
  private matches: Match[] = [];
  private searchRegex: RegExp | null = null;
  private replaceTemplate: string = "";
  private includeActiveFile: boolean = true; // 默认选中

  constructor(private context: vscode.ExtensionContext) {
    // 监听活跃编辑器变化，但由于搜索是手动触发，不需动态更新列表，只需在搜索时添加
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.html = this.getHtml();

    // 默认加入当前激活文件作为初始目标（但现在有 checkbox 控制）
    this.initDefaultTarget();

    // 消息处理
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
        case "toggleTarget":
          const t = this.targets.find((x) => x.fsPath === msg.fsPath);
          if (t) t.included = msg.checked;
          break;
        case "toggleActiveFile":
          this.includeActiveFile = msg.checked;
          break;
        case "search":
          await this.doSearch(msg.regex, msg.flags, msg.replace);
          break;
        case "replace":
          await this.doReplace();
          break;
        case "toggleMatch":
          const m = this.matches.find((x) => x.id === msg.id);
          if (m) m.checked = msg.checked;
          break;
        case "openMatch":
          const match = this.matches.find((x) => x.id === msg.id);
          if (match) {
            const doc = await vscode.workspace.openTextDocument(match.fsPath);
            const editor = await vscode.window.showTextDocument(doc);
            editor.revealRange(
              match.range,
              vscode.TextEditorRevealType.InCenter
            );
            editor.selection = new vscode.Selection(
              match.range.start,
              match.range.end
            );
          }
          break;
      }
    });
  }

  private initDefaultTarget() {
    this.postTargets(); // 初始化发送空列表或默认
  }

  private async addTargets(isFile: boolean) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: isFile,
      canSelectFolders: !isFile,
      openLabel: isFile ? "添加文件" : "添加文件夹",
    });

    if (!uris) return;

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

  private getRelativePath(fsPath: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const root = workspaceFolders[0].uri.fsPath;
      return path.relative(root, fsPath);
    }
    return fsPath;
  }

  private postTargets() {
    this._view?.webview.postMessage({
      command: "updateTargets",
      targets: this.targets.map((t) => ({
        ...t,
        displayPath: this.getRelativePath(t.fsPath),
      })),
      includeActiveFile: this.includeActiveFile,
    });
  }

  private async doSearch(regexStr: string, flags: string, replaceStr: string) {
    try {
      this.searchRegex = new RegExp(regexStr, flags);
    } catch (e) {
      vscode.window.showErrorMessage(`正则错误: ${e}`);
      return;
    }

    this.replaceTemplate = replaceStr;
    if (flags.includes("m")) {
      this.replaceTemplate = this.replaceTemplate.replace(/\\n/g, "\n");
    }

    this.matches = [];

    let includedTargets = this.targets.filter((t) => t.included);

    // 如果勾选包含当前活跃文件
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

    for (const t of includedTargets) {
      if (t.isFolder) {
        await this.searchFolder(vscode.Uri.file(t.fsPath));
      } else {
        await this.searchFile(vscode.Uri.file(t.fsPath));
      }
    }

    this.postMatches();
  }

  private async searchFolder(folderUri: vscode.Uri) {
    const entries = await fs.readdir(folderUri.fsPath, { withFileTypes: true });
    for (const entry of entries) {
      const child = vscode.Uri.file(path.join(folderUri.fsPath, entry.name));
      if (entry.isDirectory()) await this.searchFolder(child);
      else if (entry.isFile()) await this.searchFile(child);
    }
  }

  private async searchFile(fileUri: vscode.Uri) {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const content = doc.getText();

    let match;
    let idCounter = this.matches.length;

    while ((match = this.searchRegex!.exec(content)) !== null) {
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

  private computeReplacement(groups: string[]): string {
    let result = this.replaceTemplate;
    result = result.replace(/\$\$\{([^}]+)\}\$\$/g, (_, expr) => {
      try {
        const safeX: any[] = [""]; // x0 占位
        safeX.push(...groups); // x1 = groups[0], x2 = groups[1]...
        return eval(expr.replace(/x(\d+)/g, "safeX[$1]")).toString();
      } catch (e) {
        return `[Eval Error]`;
      }
    });
    return result;
  }

  private postMatches() {
    this._view?.webview.postMessage({
      command: "updateMatches",
      matches: this.matches.map((m) => ({
        id: m.id,
        fsPath: this.getRelativePath(m.fsPath),
        line: m.line,
        original:
          m.original.length > 256
            ? m.original.slice(0, 253) + "..."
            : m.original,
        replaced:
          m.replaced.length > 256
            ? m.replaced.slice(0, 253) + "..."
            : m.replaced,
        fullOriginal: m.original,
        fullReplaced: m.replaced,
        checked: m.checked,
      })),
    });
  }

  private async doReplace() {
    const toReplace = this.matches.filter((m) => m.checked);
    if (toReplace.length === 0) {
      vscode.window.showInformationMessage("没有选中的匹配项");
      return;
    }

    // 按文件分组
    const byFile: { [key: string]: Match[] } = {};
    for (const m of toReplace) {
      if (!byFile[m.fsPath]) byFile[m.fsPath] = [];
      byFile[m.fsPath].push(m);
    }

    for (const fsPath in byFile) {
      const doc = await vscode.workspace.openTextDocument(fsPath);
      const edits = new vscode.WorkspaceEdit();

      // 倒序替换防止偏移
      byFile[fsPath].sort((a, b) => b.range.start.compareTo(a.range.start));

      for (const m of byFile[fsPath]) {
        edits.replace(vscode.Uri.file(fsPath), m.range, m.replaced);
      }

      await vscode.workspace.applyEdit(edits);
      await doc.save();
    }

    vscode.window.showInformationMessage(`已替换 ${toReplace.length} 处`);
    this.matches = [];
    this.postMatches();
  }

  // 供外部调用（可选）
  addToScope(uri: vscode.Uri) {
    if (!this.targets.some((t) => t.fsPath === uri.fsPath)) {
      this.targets.push({
        fsPath: uri.fsPath,
        isFolder: false,
        included: true,
      });
      this.postTargets();
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    button { padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .section { margin-bottom: 16px; }
    h3 { margin: 8px 0 4px; font-size: 13px; }
    input[type="text"] { width: 100%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
    .list-item { display: flex; align-items: center; padding: 2px 0; gap: 8px; }
    .list-item:hover { background: var(--vscode-list-hoverBackground); }
    .remove { color: #f66; cursor: pointer; font-weight: bold; }
    .match { cursor: pointer; }
    .preview { border-top: 1px solid var(--vscode-panel-border); padding-top: 0px; font-family: var(--vscode-editor-font-family);  }
    .preview pre { background: var(--vscode-editor-background); padding: 4px; border: 1px solid var(--vscode-editor-lineHighlightBorder); overflow: auto; max-height: 200px;  word-wrap: break-word; margin:0px; }
    #matches { max-height: 500px; overflow-y: auto; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="add-file">添加文件</button>
    <button id="add-folder">添加文件夹</button>
    <label><input type="checkbox" id="include-active" checked> 包含当前活跃文件</label>
  </div>

  <div class="section">
    <h3>搜索范围</h3>
    <div id="targets"></div>
  </div>

  <div class="section">
    <label>搜索正则：</label>
    <input id="regex" type="text" placeholder="attack=(.*)" />
  </div>

  <div class="section">
    <label>替换为：</label>
    <input id="replace" type="text" placeholder="attack=($\${x1 * 2}$$)\\n" />
  </div>

  <div class="section">
    <label><input type="checkbox" id="i" checked> 忽略大小写</label>
    <label><input type="checkbox" id="m" checked> 多行模式</label>
    <label><input type="checkbox" id="s"> . 匹配换行</label>
  </div>

  <div class="toolbar">
    <button id="search-btn" style="flex:1">搜索</button>
    <button id="replace-btn" style="flex:1">替换选中</button>
  </div>

  <div class="section">
    <details open>
      <summary><h3 style="display:inline">匹配结果 (<span id="count">0</span>)</h3></summary>
      <div id="matches"></div>
    </details>
  </div>

  <div class="preview">
    <h3>预览</h3>
    <strong>Before:</strong><pre id="before"></pre>
    <strong>After:</strong><pre id="after"></pre>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // 更新目标列表
    function updateTargets(targets, includeActiveFile) {
      document.getElementById('include-active').checked = includeActiveFile;
      const container = document.getElementById('targets');
      container.innerHTML = '';
      targets.forEach(t => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = \`
          <input type="checkbox" \${t.included ? 'checked' : ''}>
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis;">\${t.displayPath}</span>
          <span class="remove">×</span>
        \`;
        div.querySelector('input').onchange = e => vscode.postMessage({command:'toggleTarget', fsPath:t.fsPath, checked:e.target.checked});
        div.querySelector('.remove').onclick = () => vscode.postMessage({command:'removeTarget', fsPath:t.fsPath});
        container.appendChild(div);
      });
    }

    // 更新匹配列表
    function updateMatches(matches) {
      document.getElementById('count').textContent = matches.length;
      const container = document.getElementById('matches');
      container.innerHTML = '';
      matches.forEach(m => {
        const div = document.createElement('div');
        div.className = 'list-item match';
        div.innerHTML = \`
          <input type="checkbox" \${m.checked ? 'checked' : ''}>
          <span style="flex:1">
            \${m.fsPath}:\${m.line}
          </span>
        \`;
        div.querySelector('input').onchange = e => vscode.postMessage({command:'toggleMatch', id:m.id, checked:e.target.checked});
        div.onclick = (e) => {
          if (e.target.type !== 'checkbox') {
            vscode.postMessage({command:'openMatch', id:m.id});
            // 显示预览
            document.getElementById('before').textContent = m.fullOriginal;
            document.getElementById('after').textContent = m.fullReplaced;
          }
        };
        container.appendChild(div);
      });
    }

    // 按钮事件
    document.getElementById('add-file').onclick = () => vscode.postMessage({command:'addFile'});
    document.getElementById('add-folder').onclick = () => vscode.postMessage({command:'addFolder'});
    document.getElementById('include-active').onchange = e => vscode.postMessage({command:'toggleActiveFile', checked:e.target.checked});
    document.getElementById('search-btn').onclick = () => {
      const regex = document.getElementById('regex').value;
      const replace = document.getElementById('replace').value;
      let flags = '';
      if (document.getElementById('i').checked) flags += 'i';
      if (document.getElementById('m').checked) flags += 'm';
      if (document.getElementById('s').checked) flags += 's';
      flags += 'g';   // 全局搜索
      vscode.postMessage({command:'search', regex, flags, replace});
    };
    document.getElementById('replace-btn').onclick = () => vscode.postMessage({command:'replace'});

    // 接收消息
    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.command === 'updateTargets') updateTargets(msg.targets, msg.includeActiveFile);
      if (msg.command === 'updateMatches') updateMatches(msg.matches);
    });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new RegexReplacerProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("regexReplacer.view", provider)
  );

  // 右键菜单快速添加
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "regexReplacer.addToScope",
      (uri: vscode.Uri) => {
        provider.addToScope(uri);
      }
    )
  );
}

export function deactivate() {}
