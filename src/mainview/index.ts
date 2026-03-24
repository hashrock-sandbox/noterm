import Electrobun, { Electroview } from "electrobun/view";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

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

const container = document.getElementById("terminal")!;
term.open(container);
fitAddon.fit();

// Send user input to bun process
term.onData((data) => {
	electrobun.rpc!.send.input({ data });
});

// Handle resize
const resizeObserver = new ResizeObserver(() => {
	fitAddon.fit();
	electrobun.rpc!.request.resize({ cols: term.cols, rows: term.rows });
});
resizeObserver.observe(container);

// Initial resize
setTimeout(() => {
	fitAddon.fit();
	electrobun.rpc!.request.resize({ cols: term.cols, rows: term.rows });
}, 100);
