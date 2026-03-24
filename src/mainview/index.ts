import Electrobun, { Electroview } from "electrobun/view";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

// --- RPC ---

type TerminalRPC = {
	bun: {
		requests: {
			resize: {
				params: { cols: number; rows: number };
				response: { success: boolean };
			};
		};
		messages: {
			input: { data: string };
		};
	};
	webview: {
		requests: {};
		messages: {
			output: { data: string };
		};
	};
};

const rpc = Electroview.defineRPC<TerminalRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {},
		messages: {
			output: ({ data }) => {
				term.write(data);
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

// --- CodeMirror ---

const editorContainer = document.getElementById("editor")!;

new EditorView({
	doc: "// Hello, noterm!\n",
	extensions: [basicSetup, javascript(), oneDark],
	parent: editorContainer,
});

// --- xterm.js ---

const terminalContainer = document.getElementById("terminal")!;

const term = new Terminal({
	cursorBlink: true,
	fontSize: 14,
	fontFamily: "Menlo, Monaco, 'Courier New', monospace",
	theme: {
		background: "#1e1e1e",
		foreground: "#d4d4d4",
		cursor: "#d4d4d4",
	},
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(terminalContainer);
fitAddon.fit();

term.onData((data) => {
	electrobun.rpc!.send.input({ data });
});

// --- Divider drag to resize ---

const divider = document.getElementById("divider")!;
const app = document.getElementById("app")!;

let dragging = false;

divider.addEventListener("mousedown", (e) => {
	dragging = true;
	e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
	if (!dragging) return;
	const appRect = app.getBoundingClientRect();
	const ratio = (e.clientY - appRect.top) / appRect.height;
	const clampedRatio = Math.max(0.1, Math.min(0.9, ratio));

	editorContainer.style.flex = "none";
	editorContainer.style.height = `${clampedRatio * 100}%`;
	terminalContainer.style.height = `${(1 - clampedRatio) * 100}%`;

	fitAddon.fit();
});

document.addEventListener("mouseup", () => {
	if (dragging) {
		dragging = false;
		fitAddon.fit();
		electrobun.rpc!.request.resize({ cols: term.cols, rows: term.rows });
	}
});

// --- Resize handling ---

const resizeObserver = new ResizeObserver(() => {
	fitAddon.fit();
	electrobun.rpc!.request.resize({ cols: term.cols, rows: term.rows });
});
resizeObserver.observe(terminalContainer);

setTimeout(() => {
	fitAddon.fit();
	electrobun.rpc!.request.resize({ cols: term.cols, rows: term.rows });
}, 100);
