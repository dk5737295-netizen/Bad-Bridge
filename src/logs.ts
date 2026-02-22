import * as vscode from "vscode";
import { BridgeClient, LogEntry } from "./bridge";

export class LogTreeProvider implements vscode.TreeDataProvider<LogItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private logs: LogEntry[] = [];
  private client: BridgeClient;
  private timer: ReturnType<typeof setInterval> | undefined;
  private _filter: string = "all"; // "all" | "errors" | "warnings" | "output"
  private _searchTerm: string = "";

  constructor(client: BridgeClient) {
    this.client = client;
  }

  get filter(): string { return this._filter; }

  setFilter(filter: string): void {
    this._filter = filter;
    this._onDidChange.fire();
  }

  setSearchTerm(term: string): void {
    this._searchTerm = term.toLowerCase();
    this._onDidChange.fire();
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
    let filtered = this.logs.slice().reverse();

    // Apply level filter
    if (this._filter === "errors") {
      filtered = filtered.filter(e => (e.type ?? "Output") === "Error");
    } else if (this._filter === "warnings") {
      filtered = filtered.filter(e => {
        const t = e.type ?? "Output";
        return t === "Warning" || t === "Error";
      });
    } else if (this._filter === "output") {
      filtered = filtered.filter(e => (e.type ?? "Output") === "Output");
    }

    // Apply search filter
    if (this._searchTerm) {
      filtered = filtered.filter(e => (e.message ?? "").toLowerCase().includes(this._searchTerm));
    }

    return filtered.slice(0, 200).map((entry) => new LogItem(entry));
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
