import Electrobun, { Electroview } from "electrobun/view";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { EditorView, minimalSetup } from "codemirror";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine } from "@codemirror/view";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import {
	StateField,
	StateEffect,
	Prec,
	type Range,
} from "@codemirror/state";
import {
	Decoration,
	WidgetType,
	keymap,
	type DecorationSet,
} from "@codemirror/view";

// --- Output routing ---

const outputHandlers = new Map<string, (data: string) => void>();

// --- RPC ---

type TerminalRPC = {
	bun: {
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
	};
	webview: {
		requests: {};
		messages: {
			output: { id: string; data: string };
		};
	};
};

const rpc = Electroview.defineRPC<TerminalRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {},
		messages: {
			output: ({ id, data }) => {
				const handler = outputHandlers.get(id);
				if (handler) handler(data);
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

// --- Inline terminal cache ---

const terminalCache = new Map<
	string,
	{ term: Terminal; fitAddon: FitAddon; element: HTMLElement }
>();

function createInlineTerminal(termId: string, view: EditorView): HTMLElement {
	const existing = terminalCache.get(termId);
	if (existing) return existing.element;

	const outer = document.createElement("div");
	outer.className = "inline-terminal-wrapper";

	const statusBar = document.createElement("div");
	statusBar.className = "inline-terminal-status";

	const termEl = document.createElement("div");
	termEl.className = "inline-terminal";

	const resizeHandle = document.createElement("div");
	resizeHandle.className = "inline-terminal-resize";

	outer.appendChild(statusBar);
	outer.appendChild(termEl);
	outer.appendChild(resizeHandle);

	const t = new Terminal({
		rows: 3,
		cursorBlink: true,
		fontSize: 13,
		fontFamily: "Menlo, Monaco, 'Courier New', monospace",
		scrollback: 1000,
		theme: {
			background: "#282c34",
			foreground: "#abb2bf",
			cursor: "#528bff",
		},
	});

	const fit = new FitAddon();
	t.loadAddon(fit);
	t.open(termEl);

	// OSC 133 detection for command state
	const osc133Re = /\x1b\]133;([A-D])(;(\d+))?\x07/g;

	outputHandlers.set(termId, (data) => {
		// Detect OSC 133 sequences
		let match;
		while ((match = osc133Re.exec(data)) !== null) {
			const code = match[1];
			if (code === "C") {
				// Command execution started
				statusBar.className = "inline-terminal-status running";
			} else if (code === "D") {
				// Command finished
				const exitCode = match[3] ? parseInt(match[3], 10) : 0;
				statusBar.className = exitCode === 0
					? "inline-terminal-status success"
					: "inline-terminal-status error";
				// Reset to idle after animation
				setTimeout(() => {
					statusBar.className = "inline-terminal-status";
				}, 2000);
			} else if (code === "A") {
				// Prompt start - idle
				statusBar.className = "inline-terminal-status";
			}
		}
		osc133Re.lastIndex = 0;
		t.write(data);
	});

	t.onData((data) => {
		electrobun.rpc!.send.input({ id: termId, data });
	});

	// ResizeObserver to notify CM of height changes
	const ro = new ResizeObserver(() => {
		(view as any).viewState.mustMeasureContent = true;
		view.requestMeasure();
	});
	ro.observe(outer);

	// Drag to resize
	let dragging = false;
	let startY = 0;
	let startH = 0;

	resizeHandle.addEventListener("mousedown", (e) => {
		dragging = true;
		startY = e.clientY;
		startH = termEl.offsetHeight;
		e.preventDefault();
	});

	function getRowHeight(): number {
		const core = (t as any)._core;
		return core?._renderService?.dimensions?.css?.cell?.height || 17;
	}

	function snapHeight(rawH: number): number {
		const rowH = getRowHeight();
		const rows = Math.max(1, Math.ceil(rawH / rowH));
		return rows * rowH;
	}

	document.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		const rawH = startH + (e.clientY - startY);
		const newH = snapHeight(rawH);
		termEl.style.height = `${newH}px`;
		fit.fit();
	});

	document.addEventListener("mouseup", () => {
		if (!dragging) return;
		dragging = false;
		fit.fit();
		electrobun.rpc!.request.resize({
			id: termId,
			cols: t.cols,
			rows: t.rows,
		});
	});

	requestAnimationFrame(() => {
		fit.fit();
		electrobun.rpc!.request.resize({
			id: termId,
			cols: t.cols,
			rows: t.rows,
		});
	});

	terminalCache.set(termId, { term: t, fitAddon: fit, element: outer });
	return outer;
}

// --- CodeMirror terminal widget ---

class TerminalWidget extends WidgetType {
	constructor(readonly termId: string) {
		super();
	}

	eq(other: TerminalWidget) {
		return this.termId === other.termId;
	}

	toDOM(view: EditorView) {
		return createInlineTerminal(this.termId, view);
	}

	get estimatedHeight() {
		return 66;
	}

	ignoreEvent() {
		return true;
	}
}

// --- CodeMirror state for inline terminals ---

const addTerminalEffect = StateEffect.define<{ pos: number; id: string }>();

const terminalField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(decos, tr) {
		decos = decos.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(addTerminalEffect)) {
				const deco = Decoration.widget({
					widget: new TerminalWidget(effect.value.id),
					block: true,
				});
				const newDecos: Range<Decoration>[] = [];
				const iter = decos.iter();
				while (iter.value) {
					newDecos.push(iter.value.range(iter.from, iter.to));
					iter.next();
				}
				newDecos.push(deco.range(effect.value.pos));
				newDecos.sort((a, b) => a.from - b.from);
				decos = Decoration.set(newDecos);
			}
		}
		return decos;
	},
	provide: (f) => EditorView.decorations.from(f),
});

// --- /term keymap ---

const termCommand = keymap.of([
	{
		key: "Enter",
		run(view) {
			const { state } = view;
			const line = state.doc.lineAt(state.selection.main.head);
			if (line.text.trim() !== "/term") return false;

			electrobun
				.rpc!.request.createTerminal({ cols: 80, rows: 3 })
				.then(({ id }) => {
					view.dispatch({
						changes: { from: line.from, to: line.to, insert: "" },
						effects: addTerminalEffect.of({ pos: line.from, id }),
					});
				});

			return true;
		},
	},
]);

// --- CodeMirror ---

const editorContainer = document.getElementById("editor")!;

new EditorView({
	doc: "// noterm - type /term to embed a terminal\n\n",
	extensions: [
		minimalSetup,
		lineNumbers(),
		highlightActiveLineGutter(),
		highlightActiveLine(),
		bracketMatching(),
		foldGutter(),
		history(),
		keymap.of(historyKeymap),
		javascript(),
		oneDark,
		terminalField,
		Prec.highest(termCommand),
	],
	parent: editorContainer,
});
