# Regex Replacer

**Advanced Regex Search & Programmable Replacement for VS Code**

一款支持 **JavaScript 可编程替换** 的高级正则工具，让正则替换从简单文本处理升级为真正的计算与逻辑处理。

---

### English | 中文

**A powerful VS Code extension for advanced regex search and programmable replacement** across files and folders.

提供侧边栏界面，支持多文件/文件夹范围管理、匹配预览、选择性替换，并可在替换模板中执行 JavaScript 表达式。

**Core Feature**: Use `$${...}$$` syntax to run JavaScript on capture groups (e.g. `$${x1 * 2}$$`, `$${x1.toUpperCase()}$$`).

**核心亮点**：在替换中使用 `$${...}$$` 包裹 JavaScript 表达式，对捕获组（`x1`、`x2`...）进行数学计算、字符串处理等复杂操作。

---

## ✨ Features | 主要特性

### 🧠 Programmable Replacement | 可编程替换
- 支持在替换模板中嵌入 JavaScript 代码
- 使用 `$${expression}$$` 语法
- 示例：
  - Search: `attack=(\d+)`
  - Replace: `attack=($${x1 * 2}$$)\\n`
  - 效果：把捕获的数字乘以 2，并添加换行
- Supports embedding JavaScript code in replacement templates
- Use the `$${expression}$$` syntax
- Example:
  - Search: `attack=(\d+)`
  - Replacement: `attack=($${x1 * 2}$$)\\n`
  - Result: Multiplies the captured number by 2 and adds a newline

### 🎨 Clean Sidebar Panel | 直观侧边栏界面
- 添加文件或文件夹到搜索范围
- 一键包含当前活跃文件（默认开启）
- 正则输入 + 标志位控制（i / m / s）
- 替换模板输入框（支持 JS 表达式）
- Add files or folders to the search scope
- Include the currently active file with a single click (enabled by default)
- Regular expression input with flag control (i / m / s)
- Replace template input field (supports JS expressions)

### 📋 Smart Match List | 智能匹配列表
- 复选框选择性替换
- 显示 **原始内容 → 替换后预览**
- 点击匹配项可直接跳转到文件位置
- Selective replacement using checkboxes
- Display **Original content → Preview after replacement**
- Click a match to jump directly to the file location

### 🔍 Detailed Preview | 详细预览面板
- 多行内容的 Before / After 对比预览
- 清晰直观，方便确认替换效果
- Before/After comparison preview for multi-line content
- Clear and intuitive, making it easy to see the results of the replacement
---

## Quick Example | 快速示例

**场景**：将日志中的 `score=85` 变为 `score=170`（数值翻倍）并换行。

**Scenario**: Replace `score=85` with `score=170` (double the value) in the log and insert a newline.

**Search Regex**  
`score=(\d+)`

**Replace**  
`score=($${x1 * 2}$$)\\n`

**Flags**：Global + Ignore Case + Multiline



搜索后你可以只选择部分匹配进行替换，并实时查看预览效果。
---

**Developed with ❤️**

欢迎反馈、建议和功能请求！

- GitHub: [请填入你的仓库链接]
- Issues: [请填入 Issues 链接]

有任何问题或想要的新功能，随时告诉我！