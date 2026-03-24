import { BrowserView, BrowserWindow, type RPCSchema } from "electrobun/bun";
import { spawn } from "bun-pty";

type TerminalRPC = {
	bun: RPCSchema<{
		requests: {
			createTerminal: {
				params: { cols: number; rows: number };
				response: { id: string };
			};
			resize: {
				params: { id: string; cols: number; rows: number };
				response: { success: boolean };
			};
		};
		messages: {
			input: { id: string; data: string };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			output: { id: string; data: string };
		};
	}>;
};

const shell = Bun.env["SHELL"] || "/bin/zsh";
const shellArgs = shell.endsWith("zsh") || shell.endsWith("bash") ? ["-il"] : [];

const ptyMap = new Map<string, ReturnType<typeof spawn>>();
let idCounter = 0;

function createPty(cols: number, rows: number): string {
	const id = `term-${idCounter++}`;
	const pty = spawn(shell, shellArgs, {
		cwd: Bun.env["HOME"] || "/",
		cols,
		rows,
		name: "xterm-256color",
		env: {
			...Bun.env,
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		},
	});

	ptyMap.set(id, pty);

	pty.onData((data: string) => {
		terminalRPC.send.output({ id, data });
	});

	pty.onExit(({ exitCode }: { exitCode: number }) => {
		console.log(`PTY ${id} exited with code ${exitCode}`);
		terminalRPC.send.output({ id, data: `\r\n[Process exited with code ${exitCode}]\r\n` });
		ptyMap.delete(id);
	});

	console.log(`PTY created: ${id}, pid: ${pty.pid}`);
	return id;
}

const terminalRPC = BrowserView.defineRPC<TerminalRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {
			createTerminal: ({ cols, rows }) => {
				const id = createPty(cols, rows);
				return { id };
			},
			resize: ({ id, cols, rows }) => {
				const pty = ptyMap.get(id);
				if (pty) {
					pty.resize(cols, rows);
					return { success: true };
				}
				return { success: false };
			},
		},
		messages: {
			input: ({ id, data }) => {
				const pty = ptyMap.get(id);
				if (pty) {
					pty.write(data);
				}
			},
		},
	},
});

const mainWindow = new BrowserWindow({
	title: "noterm",
	url: "views://mainview/index.html",
	rpc: terminalRPC,
	frame: {
		width: 800,
		height: 900,
		x: 200,
		y: 200,
	},
});

console.log("noterm started!");
