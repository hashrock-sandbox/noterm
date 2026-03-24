import { BrowserView, BrowserWindow, type RPCSchema } from "electrobun/bun";
import { spawn } from "bun-pty";

type TerminalRPC = {
	bun: RPCSchema<{
		requests: {
			resize: {
				params: { cols: number; rows: number };
				response: { success: boolean };
			};
		};
		messages: {
			input: { data: string };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			output: { data: string };
		};
	}>;
};

const shell = Bun.env["SHELL"] || "/bin/zsh";
const shellArgs = shell.endsWith("zsh") || shell.endsWith("bash") ? ["-il"] : [];

const pty = spawn(shell, shellArgs, {
	cwd: Bun.env["HOME"] || "/",
	cols: 80,
	rows: 24,
	name: "xterm-256color",
	env: {
		...Bun.env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	},
});

console.log(`PTY spawned: ${shell}, pid: ${pty.pid}`);

let rpcReady = false;
let outputBuffer: string[] = [];

const terminalRPC = BrowserView.defineRPC<TerminalRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {
			resize: ({ cols, rows }) => {
				pty.resize(cols, rows);
				return { success: true };
			},
		},
		messages: {
			input: ({ data }) => {
				pty.write(data);
			},
		},
	},
});

function sendOutput(text: string) {
	if (rpcReady) {
		terminalRPC.send.output({ data: text });
	} else {
		outputBuffer.push(text);
	}
}

pty.onData((data: string) => {
	sendOutput(data);
});

pty.onExit(({ exitCode }: { exitCode: number }) => {
	console.log(`Shell exited with code ${exitCode}`);
	sendOutput(`\r\n[Process exited with code ${exitCode}]\r\n`);
});

const mainWindow = new BrowserWindow({
	title: "Terminal",
	url: "views://mainview/index.html",
	rpc: terminalRPC,
	frame: {
		width: 800,
		height: 500,
		x: 200,
		y: 200,
	},
});

mainWindow.on("dom-ready", () => {
	console.log("DOM ready, flushing buffer");
	rpcReady = true;
	for (const text of outputBuffer) {
		terminalRPC.send.output({ data: text });
	}
	outputBuffer = [];
});

console.log("Terminal app started!");
