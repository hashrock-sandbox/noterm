import { BrowserView, BrowserWindow, ApplicationMenu, Utils, type RPCSchema } from "electrobun/bun";
import { spawn } from "bun-pty";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

type TerminalRPC = {
	bun: RPCSchema<{
		requests: {
			createTerminal: {
				params: { cols: number; rows: number; cwd?: string };
				response: { id: string };
			};
			getCwd: {
				params: { id: string };
				response: { cwd: string | null };
			};
			resize: {
				params: { id: string; cols: number; rows: number };
				response: { success: boolean };
			};
			saveDoc: {
				params: { content: string };
				response: { success: boolean };
			};
			loadDoc: {
				params: {};
				response: { content: string | null };
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
			terminalExited: { id: string; exitCode: number };
		};
	}>;
};

// Document storage
const dataDir = join(Utils.paths.userData, "docs");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const docPath = join(dataDir, "scratch.md");

const shell = Bun.env["SHELL"] || "/bin/zsh";
const shellArgs = shell.endsWith("zsh") || shell.endsWith("bash") ? ["-il"] : [];

const ptyMap = new Map<string, ReturnType<typeof spawn>>();
let idCounter = 0;

function resolveCwd(cwd?: string): string {
	if (!cwd || cwd === "~") return Bun.env["HOME"] || "/";
	if (cwd.startsWith("~/")) return join(Bun.env["HOME"] || "/", cwd.slice(2));
	return cwd;
}

function createPty(cols: number, rows: number, cwd?: string): string {
	const id = `term-${idCounter++}`;
	const pty = spawn(shell, shellArgs, {
		cwd: resolveCwd(cwd),
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
		ptyMap.delete(id);
		terminalRPC.send.terminalExited({ id, exitCode });
	});

	// Inject shell integration for OSC 133 semantic prompts
	if (shell.endsWith("zsh")) {
		pty.write([
			`precmd()  { printf '\\e]133;D;%s\\a\\e]133;A\\a' "$?" }`,
			`preexec() { printf '\\e]133;C\\a' }`,
			"clear",
			"",
		].join("\n"));
	} else if (shell.endsWith("bash")) {
		pty.write([
			`PROMPT_COMMAND='printf "\\e]133;D;\$?\\a\\e]133;A\\a"'`,
			`trap 'printf "\\e]133;C\\a"' DEBUG`,
			"clear",
			"",
		].join("\n"));
	}

	console.log(`PTY created: ${id}, pid: ${pty.pid}`);
	return id;
}

const terminalRPC = BrowserView.defineRPC<TerminalRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {
			createTerminal: ({ cols, rows, cwd }) => {
				const id = createPty(cols, rows, cwd);
				return { id };
			},
			getCwd: ({ id }) => {
				const pty = ptyMap.get(id);
				if (!pty) return { cwd: null };
				try {
					const result = Bun.spawnSync({
						cmd: ["lsof", "-a", "-d", "cwd", "-Fn", "-p", String(pty.pid)],
					});
					const output = result.stdout.toString();
					const match = output.match(/\nn(.*)/);
					return { cwd: match ? match[1] : null };
				} catch {
					return { cwd: null };
				}
			},
			saveDoc: async ({ content }) => {
				await Bun.write(docPath, content);
				return { success: true };
			},
			loadDoc: () => {
				if (existsSync(docPath)) {
					const text = require("fs").readFileSync(docPath, "utf-8");
					return { content: text };
				}
				return { content: null };
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

// Window state persistence
const windowStatePath = join(dataDir, "window-state.json");

function loadWindowState(): { width: number; height: number; x: number; y: number } {
	try {
		if (existsSync(windowStatePath)) {
			const data = require("fs").readFileSync(windowStatePath, "utf-8");
			return JSON.parse(data);
		}
	} catch {}
	return { width: 800, height: 900, x: 200, y: 200 };
}

const savedFrame = loadWindowState();

const mainWindow = new BrowserWindow({
	title: "noterm",
	url: "views://mainview/index.html",
	rpc: terminalRPC,
	frame: savedFrame,
	titleBarStyle: "hiddenInset",
});

// Periodically save window state
setInterval(async () => {
	try {
		const frame = mainWindow.getFrame();
		if (frame) {
			await Bun.write(windowStatePath, JSON.stringify(frame));
		}
	} catch {}
}, 5000);

// Application menu with Edit roles for copy/paste support
ApplicationMenu.setApplicationMenu([
	{
		label: "noterm",
		type: "normal",
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "Edit",
		type: "normal",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	},
]);

console.log("noterm started!");
