import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function setLogChannel(value: vscode.OutputChannel): void {
    channel = value;
}

/** Appends a timestamped line to the "Fast Index" output channel. */
export function log(message: string): void {
    const stamp = new Date().toISOString().substring(11, 23);
    channel?.appendLine(`[${stamp}] ${message}`);
}
