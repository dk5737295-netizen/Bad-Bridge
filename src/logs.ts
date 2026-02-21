import * as vscode from "vscode";
import { BridgeClient, LogEntry } from "./bridge";

export class LogTreeProvider implements vscode.TreeDataProvider<LogItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private logs: LogEntry[] = [];
  private client: BridgeClient;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(client: BridgeClient) {
    this.client = client;
  }

  startPolling(intervalSec: number): void {
    this.stopPolling();
    this.timer = setInterval(() => this.refresh(), intervalSec * 1000);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(): Promise<void> {
    this.logs = await this.client.getLogs();
    this._onDidChange.fire();
  }

  async clear(): Promise<void> {
    await this.client.clearLogs();
    this.logs = [];
    this._onDidChange.fire();
  }

  getTreeItem(el: LogItem): vscode.TreeItem {
    return el;
  }

  getChildren(): LogItem[] {
    // Show newest first
    return this.logs
      .slice()
      .reverse()
      .slice(0, 200)
      .map((entry) => new LogItem(entry));
  }

  dispose(): void {
    this.stopPolling();
    this._onDidChange.dispose();
  }
}

class LogItem extends vscode.TreeItem {
  constructor(entry: LogEntry) {
    const type = entry.type ?? "Output";
    const message = entry.message ?? "(empty)";
    const icon = type === "Error" ? "error"
      : type === "Warning" ? "warning"
      : "info";
    const msg = message.length > 200
      ? message.substring(0, 200) + "…"
      : message;

    super(msg, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = message;
    this.description = type;
  }
}
