import * as vscode from "vscode";
import { BridgeClient } from "./bridge";

export class BridgeWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "bad-bridge.panel";

  private view?: vscode.WebviewView;
  private client: BridgeClient;
  private connected = false;
  private statusTimer?: ReturnType<typeof setInterval>;
  private outputChannel: vscode.OutputChannel;

  constructor(client: BridgeClient, outputChannel: vscode.OutputChannel) {
    this.client = client;
    this.outputChannel = outputChannel;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.cmd) {
        case "run":
          await this.runCode(msg.code);
          break;
        case "tree":
          await this.runTree(msg.path, msg.depth, msg.props);
          break;
        case "find":
          await this.runFind(msg.path, msg.name, msg.className);
          break;
        case "undo":
          await this.execSimple(this.client.undo(msg.steps ?? 1), "Undo");
          break;
        case "redo":
          await this.execSimple(this.client.redo(msg.steps ?? 1), "Redo");
          break;
        case "clearQueue":
          await this.client.clearQueue();
          this.postMessage({ type: "toast", text: "Queue cleared" });
          break;
        case "insertModel":
          await this.runInsertModel(msg.query);
          break;
        case "startPlay":
          await this.execSimple(this.client.startStopPlay("start_play"), "Start Play");
          break;
        case "runServer":
          await this.execSimple(this.client.startStopPlay("run_server"), "Run Server");
          break;
        case "stopPlay":
          await this.execSimple(this.client.startStopPlay("stop"), "Stop");
          break;
        case "runScriptInPlayMode":
          await this.runScriptInPlayMode(msg.code, msg.mode);
          break;
        case "getStudioMode":
          await this.execSimple(this.client.getStudioMode(), "Studio Mode");
          break;
        case "getConsoleOutput":
          await this.execSimple(this.client.getConsoleOutput(false), "Console Output");
          break;
        case "createInstance":
          await this.execSimple(
            this.client.createInstance(msg.className, msg.parent, msg.name),
            "Create Instance"
          );
          break;
        case "deleteInstance":
          await this.execSimple(this.client.deleteInstance(msg.path), "Delete");
          break;
        case "cloneInstance":
          await this.execSimple(this.client.cloneInstance(msg.path, msg.parent), "Clone");
          break;
        case "setProperty":
          await this.execSimple(this.client.setProperty(msg.path, msg.property, msg.value), "Set Property");
          break;
        case "moveInstance":
          await this.execSimple(this.client.moveInstance(msg.path, msg.parent), "Move");
          break;
        case "renameInstance":
          await this.execSimple(this.client.renameInstance(msg.path, msg.name), "Rename");
          break;
        case "getSelection":
          await this.execSimple(this.client.getSelection(), "Selection");
          break;
        case "getScriptSource":
          await this.runGetScriptSource(msg.path);
          break;
        case "ping":
          await this.checkStatus();
          break;
      }
    });

    // Poll connection status every 5s
    this.statusTimer = setInterval(() => this.checkStatus(), 5000);
    this.checkStatus();

    view.onDidDispose(() => {
      if (this.statusTimer) { clearInterval(this.statusTimer); }
    });
  }

  private postMessage(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  private async checkStatus(): Promise<void> {
    const ok = await this.client.ping();
    this.connected = ok;
    const depth = ok ? await this.client.getQueueDepth() : -1;
    this.postMessage({ type: "status", connected: ok, queue: depth });
  }

  private async runCode(code: string): Promise<void> {
    this.postMessage({ type: "running", text: "Executing..." });
    const result = await this.client.run(code);
    this.showResult(result, "Run");
  }

  private async runTree(path: string, depth: number, props: boolean): Promise<void> {
    this.postMessage({ type: "running", text: "Fetching tree..." });
    const result = await this.client.getTree(path || "game", depth || 4, props);
    this.showResult(result, "Tree");
  }

  private async runFind(path: string, name: string, className: string): Promise<void> {
    this.postMessage({ type: "running", text: "Searching..." });
    const result = await this.client.find(path || "game", {
      name: name || undefined,
      class: className || undefined,
      limit: 50,
    });
    this.showResult(result, "Find");
  }

  private async runInsertModel(query: string): Promise<void> {
    this.postMessage({ type: "running", text: "Inserting model..." });
    const result = await this.client.insertModel(query);
    this.showResult(result, "Insert Model");
  }

  private async runScriptInPlayMode(code: string, mode: string): Promise<void> {
    this.postMessage({ type: "running", text: "Running script in play mode..." });
    const result = await this.client.runScriptInPlayMode(code, mode || "start_play");
    this.showResult(result, "Run Script in Play Mode");
  }

  private async runGetScriptSource(path: string): Promise<void> {
    this.postMessage({ type: "running", text: "Reading script source..." });
    const result = await this.client.getScriptSource(path);
    this.showResult(result, "Script Source");
  }

  private async execSimple(promise: Promise<unknown>, label: string): Promise<void> {
    this.postMessage({ type: "running", text: `${label}...` });
    const result = await promise;
    this.showResult(result as any, label);
  }

  private showResult(result: unknown, label: string): void {
    if (!result) {
      this.postMessage({ type: "result", text: "Timeout — no response from Studio" });
      return;
    }
    const pretty = JSON.stringify(result, null, 2) ?? "(null)";
    this.outputChannel.appendLine(`\n━━━ ${label} ━━━`);
    this.outputChannel.appendLine(pretty);
    this.outputChannel.show(true);
    const preview = pretty.length > 500 ? pretty.substring(0, 500) + "\n..." : pretty;
    this.postMessage({ type: "result", text: preview });
  }

  setConnected(val: boolean): void {
    this.connected = val;
    this.postMessage({ type: "status", connected: val, queue: 0 });
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --btn-sec-bg: var(--vscode-button-secondaryBackground);
    --btn-sec-fg: var(--vscode-button-secondaryForeground);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); padding: 10px; }

  .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #888; flex-shrink: 0; }
  .dot.on { background: #4ec760; }
  .dot.off { background: #e64545; }
  .status-text { flex: 1; }

  .section { margin-bottom: 14px; }
  .section-title { font-weight: 600; margin-bottom: 6px; font-size: 12px; text-transform: uppercase; opacity: 0.7; }

  input, textarea {
    width: 100%; padding: 5px 8px; border: 1px solid var(--input-border);
    background: var(--input-bg); color: var(--input-fg); border-radius: 3px;
    font-family: var(--vscode-editor-font-family); font-size: 12px;
  }
  textarea { resize: vertical; min-height: 60px; }

  .row { display: flex; gap: 6px; margin-top: 6px; }
  .row input { flex: 1; }

  button {
    padding: 5px 12px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--btn-bg); color: var(--btn-fg); font-size: 12px;
  }
  button:hover { background: var(--btn-hover); }
  button.sec { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }

  .btn-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }

  .result-box {
    margin-top: 10px; padding: 8px; border-radius: 4px;
    background: var(--input-bg); font-family: var(--vscode-editor-font-family);
    font-size: 11px; white-space: pre-wrap; word-break: break-all;
    max-height: 200px; overflow-y: auto; display: none;
  }
</style>
</head>
<body>
  <!-- Status -->
  <div class="status-row">
    <div class="dot" id="dot"></div>
    <span class="status-text" id="statusText">Checking...</span>
    <button class="sec" onclick="send({cmd:'ping'})" style="font-size:11px;">Refresh</button>
  </div>

  <!-- Run Code -->
  <div class="section">
    <div class="section-title">Run Luau</div>
    <textarea id="code" placeholder="return game.Workspace:GetChildren()" rows="3"></textarea>
    <div class="btn-row">
      <button onclick="doRun()">Execute</button>
    </div>
  </div>

  <!-- Tree -->
  <div class="section">
    <div class="section-title">Instance Tree</div>
    <div class="row">
      <input id="treePath" placeholder="game.Workspace" value="game"/>
      <input id="treeDepth" type="number" value="3" style="width:55px;"/>
    </div>
    <div class="btn-row">
      <button onclick="doTree(false)">Tree</button>
      <button class="sec" onclick="doTree(true)">Tree + Props</button>
    </div>
  </div>

  <!-- Find -->
  <div class="section">
    <div class="section-title">Find</div>
    <div class="row">
      <input id="findPath" placeholder="game" value="game"/>
      <input id="findName" placeholder="Name"/>
      <input id="findClass" placeholder="Class"/>
    </div>
    <div class="btn-row">
      <button onclick="doFind()">Search</button>
    </div>
  </div>

  <!-- Insert Model -->
  <div class="section">
    <div class="section-title">Insert Model</div>
    <div class="row">
      <input id="modelQuery" placeholder="tree, car, sword..."/>
    </div>
    <div class="btn-row">
      <button onclick="doInsertModel()">Insert</button>
    </div>
  </div>

  <!-- Play Controls -->
  <div class="section">
    <div class="section-title">Play Controls</div>
    <div class="btn-row">
      <button onclick="send({cmd:'startPlay'})" style="background:#4ec760;color:#000;">&#9654; Play</button>
      <button class="sec" onclick="send({cmd:'runServer'})">Run Server</button>
      <button onclick="send({cmd:'stopPlay'})" style="background:#e64545;">&#9724; Stop</button>
    </div>
    <div class="btn-row" style="margin-top:4px;">
      <button class="sec" onclick="send({cmd:'getStudioMode'})">Get Mode</button>
      <button class="sec" onclick="send({cmd:'getConsoleOutput'})">Console Output</button>
    </div>
  </div>

  <!-- Run Script in Play Mode -->
  <div class="section">
    <div class="section-title">Run Script in Play Mode</div>
    <textarea id="playCode" placeholder='print("Hello from play mode!")' rows="2"></textarea>
    <div class="row" style="margin-top:4px;">
      <select id="playMode" style="flex:1;padding:4px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;font-size:12px;">
        <option value="start_play">Play Mode</option>
        <option value="run_server">Server Mode</option>
      </select>
      <button onclick="doRunInPlay()">Run</button>
    </div>
  </div>

  <!-- Instance Manipulation -->
  <div class="section">
    <div class="section-title">Instance Tools</div>
    <div class="row">
      <input id="instClass" placeholder="Class (Part)" style="flex:1;"/>
      <input id="instParent" placeholder="Parent" value="game.Workspace" style="flex:1;"/>
      <input id="instName" placeholder="Name" style="flex:1;"/>
    </div>
    <div class="btn-row">
      <button onclick="doCreate()">Create</button>
    </div>
    <div class="row" style="margin-top:6px;">
      <input id="instPath" placeholder="game.Workspace.Part" style="flex:1;"/>
    </div>
    <div class="btn-row">
      <button class="sec" onclick="doDelete()">Delete</button>
      <button class="sec" onclick="doClone()">Clone</button>
      <button class="sec" onclick="send({cmd:'getSelection'})">Get Selection</button>
    </div>
    <div class="row" style="margin-top:6px;">
      <input id="propName" placeholder="Property" style="flex:1;"/>
      <input id="propValue" placeholder="Value" style="flex:1;"/>
    </div>
    <div class="btn-row">
      <button onclick="doSetProp()">Set Property</button>
    </div>
    <div class="row" style="margin-top:6px;">
      <input id="renamePath" placeholder="Path" style="flex:1;"/>
      <input id="newName" placeholder="New Name" style="flex:1;"/>
    </div>
    <div class="btn-row">
      <button class="sec" onclick="doRename()">Rename</button>
    </div>
    <div class="row" style="margin-top:6px;">
      <input id="movePath" placeholder="Instance path" style="flex:1;"/>
      <input id="moveParent" placeholder="New parent" style="flex:1;"/>
    </div>
    <div class="btn-row">
      <button class="sec" onclick="doMove()">Move</button>
    </div>
  </div>

  <!-- Script Source -->
  <div class="section">
    <div class="section-title">Script Source</div>
    <div class="row">
      <input id="scriptPath" placeholder="game.ServerScriptService.Script" style="flex:1;"/>
    </div>
    <div class="btn-row">
      <button onclick="doGetScript()">Read Source</button>
    </div>
  </div>

  <!-- Actions -->
  <div class="section">
    <div class="section-title">Actions</div>
    <div class="btn-row">
      <button class="sec" onclick="send({cmd:'undo'})">Undo</button>
      <button class="sec" onclick="send({cmd:'redo'})">Redo</button>
      <button class="sec" onclick="send({cmd:'clearQueue'})">Clear Queue</button>
    </div>
  </div>

  <!-- Result preview -->
  <div class="result-box" id="result"></div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  function send(msg) { vscode.postMessage(msg); }

  function doRun() {
    const code = $("code").value.trim();
    if (!code) return;
    send({ cmd: "run", code });
  }

  function doTree(props) {
    send({
      cmd: "tree",
      path: $("treePath").value || "game",
      depth: parseInt($("treeDepth").value) || 3,
      props: !!props,
    });
  }

  function doFind() {
    send({
      cmd: "find",
      path: $("findPath").value || "game",
      name: $("findName").value,
      className: $("findClass").value,
    });
  }

  function doInsertModel() {
    const q = $("modelQuery").value.trim();
    if (!q) return;
    send({ cmd: "insertModel", query: q });
  }

  function doRunInPlay() {
    const code = $("playCode").value.trim();
    if (!code) return;
    const mode = $("playMode").value;
    send({ cmd: "runScriptInPlayMode", code, mode });
  }

  function doCreate() {
    const cls = $("instClass").value.trim();
    if (!cls) return;
    send({ cmd: "createInstance", className: cls, parent: $("instParent").value || "game.Workspace", name: $("instName").value || undefined });
  }

  function doDelete() {
    const p = $("instPath").value.trim();
    if (!p) return;
    send({ cmd: "deleteInstance", path: p });
  }

  function doClone() {
    const p = $("instPath").value.trim();
    if (!p) return;
    send({ cmd: "cloneInstance", path: p });
  }

  function doSetProp() {
    const p = $("instPath").value.trim();
    const prop = $("propName").value.trim();
    let val = $("propValue").value;
    if (!p || !prop) return;
    try { val = JSON.parse(val); } catch {}
    send({ cmd: "setProperty", path: p, property: prop, value: val });
  }

  function doRename() {
    const p = $("renamePath").value.trim();
    const n = $("newName").value.trim();
    if (!p || !n) return;
    send({ cmd: "renameInstance", path: p, name: n });
  }

  function doMove() {
    const p = $("movePath").value.trim();
    const par = $("moveParent").value.trim();
    if (!p || !par) return;
    send({ cmd: "moveInstance", path: p, parent: par });
  }

  function doGetScript() {
    const p = $("scriptPath").value.trim();
    if (!p) return;
    send({ cmd: "getScriptSource", path: p });
  }

  // Ctrl+Enter in textarea
  $("code").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doRun(); }
  });
  $("playCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doRunInPlay(); }
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    const dot = $("dot");
    const st = $("statusText");
    const rb = $("result");

    switch (msg.type) {
      case "status":
        dot.className = "dot " + (msg.connected ? "on" : "off");
        st.textContent = msg.connected
          ? "Connected" + (msg.queue > 0 ? " (queue: " + msg.queue + ")" : "")
          : "Disconnected";
        break;
      case "running":
        rb.style.display = "block";
        rb.textContent = msg.text;
        break;
      case "result":
        rb.style.display = "block";
        rb.textContent = msg.text;
        break;
      case "toast":
        rb.style.display = "block";
        rb.textContent = msg.text;
        setTimeout(() => { rb.style.display = "none"; }, 3000);
        break;
    }
  });
</script>
</body>
</html>`;
  }
}
