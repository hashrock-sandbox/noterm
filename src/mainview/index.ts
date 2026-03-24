import Electrobun, { Electroview } from "electrobun/view";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { EditorView, minimalSetup } from "codemirror";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine } from "@codemirror/view";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import {
	StateField,
	StateEffect,
	Prec,
	type Range,
} from "@codemirror/state";
import {
	Decoration,
	WidgetType,
	ViewPlugin,
	keymap,
	type DecorationSet,
	type ViewUpdate,
} from "@codemirror/view";

// --- Output routing ---

const outputHandlers = new Map<string, (data: string) => void>();

// --- RPC ---

type TerminalRPC = {
	bun: {
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
	};
	webview: {
		requests: {};
		messages: {
			output: { id: string; data: string };
			terminalExited: { id: string; exitCode: number };
		};
	};
};

// Will be set after EditorView is created
let cmView: EditorView;

const rpc = Electroview.defineRPC<TerminalRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {},
		messages: {
			output: ({ id, data }) => {
				const handler = outputHandlers.get(id);
				if (handler) handler(data);
			},
			terminalExited: ({ id }) => {
				replaceTerminalWithText(id);
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

function extractTerminalText(termId: string): string {
	const cached = terminalCache.get(termId);
	if (!cached) return "";
	const buf = cached.term.buffer.active;
	const lines: string[] = [];
	for (let i = 0; i <= buf.cursorY; i++) {
		const line = buf.getLine(i);
		if (line) lines.push(line.translateToString(true));
	}
	// Trim trailing empty lines
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
		lines.pop();
	}
	return lines.join("\n");
}

function findTerminalPosition(termId: string): number | null {
	const decos = cmView.state.field(terminalField);
	const iter = decos.iter();
	while (iter.value) {
		const widget = (iter.value.spec as any).widget as TerminalWidget;
		if (widget.termId === termId) return iter.from;
		iter.next();
	}
	return null;
}

function replaceTerminalWithText(termId: string) {
	const text = extractTerminalText(termId);
	const pos = findTerminalPosition(termId);
	if (pos === null) return;

	// Clean up
	outputHandlers.delete(termId);
	terminalCache.delete(termId);

	cmView.dispatch({
		changes: { from: pos, to: pos, insert: text },
		effects: removeTerminalEffect.of(termId),
	});
}

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

	const titleEl = document.createElement("div");
	titleEl.className = "inline-terminal-title";

	const termEl = document.createElement("div");
	termEl.className = "inline-terminal";

	const resizeHandle = document.createElement("div");
	resizeHandle.className = "inline-terminal-resize";

	outer.appendChild(statusBar);
	outer.appendChild(titleEl);
	outer.appendChild(termEl);
	outer.appendChild(resizeHandle);

	const t = new Terminal({
		rows: 10,
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

	// OSC 0 (window title) detection
	const osc0Re = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

	// OSC 133 detection for command state
	// BEL (\x07) or ST (\x1b\\) as terminator
	const osc133Re = /\x1b\]133;([A-D])(;(\d+))?(?:\x07|\x1b\\)/g;

	let resultTimer: ReturnType<typeof setTimeout> | null = null;

	outputHandlers.set(termId, (data) => {
		let match;
		while ((match = osc133Re.exec(data)) !== null) {
			const code = match[1];
			if (code === "C") {
				if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
				statusBar.className = "inline-terminal-status";
			} else if (code === "D") {
				const exitCode = match[3] ? parseInt(match[3], 10) : 0;
				statusBar.className = exitCode === 0
					? "inline-terminal-status success"
					: "inline-terminal-status error";
				resultTimer = setTimeout(() => {
					statusBar.className = "inline-terminal-status";
					resultTimer = null;
				}, 2000);
			} else if (code === "A") {
				// Don't reset if showing result animation
				if (!resultTimer) {
					statusBar.className = "inline-terminal-status";
				}
			}
		}
		osc133Re.lastIndex = 0;

		// Detect OSC 0 (window title)
		let titleMatch;
		while ((titleMatch = osc0Re.exec(data)) !== null) {
			titleEl.textContent = titleMatch[1];
		}
		osc0Re.lastIndex = 0;

		t.write(data);
	});

	t.onData((data) => {
		electrobun.rpc!.send.input({ id: termId, data });
	});

	// Key event handling in terminal
	t.attachCustomKeyEventHandler((e) => {
		// Let Cmd+C / Cmd+V pass through to browser
		if (e.metaKey && (e.key === "c" || e.key === "v")) {
			return false;
		}
		if (e.type === "keydown") {
			// Return focus to CodeMirror: Ctrl+`, Cmd+Escape, Ctrl+O
			if (
				(e.ctrlKey && e.key === "`") ||
				(e.metaKey && e.key === "Escape") ||
				(e.ctrlKey && e.key === "o")
			) {
				view.focus();
				return false;
			}
		}
		return true;
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
const removeTerminalEffect = StateEffect.define<string>(); // termId

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
			if (effect.is(removeTerminalEffect)) {
				const removeId = effect.value;
				const kept: Range<Decoration>[] = [];
				const iter = decos.iter();
				while (iter.value) {
					const widget = (iter.value.spec as any).widget as TerminalWidget;
					if (widget.termId !== removeId) {
						kept.push(iter.value.range(iter.from, iter.to));
					}
					iter.next();
				}
				decos = Decoration.set(kept);
			}
		}
		return decos;
	},
	provide: (f) => EditorView.decorations.from(f),
});

// --- Button widget ---

class ButtonWidget extends WidgetType {
	constructor(readonly label: string) {
		super();
	}

	eq(other: ButtonWidget) {
		return this.label === other.label;
	}

	toDOM(view: EditorView) {
		const btn = document.createElement("button");
		btn.className = "inline-button";
		btn.textContent = this.label;
		btn.addEventListener("click", () => {
			// Find the nearest terminal above this button
			const pos = view.posAtDOM(btn);
			const termId = findNearestTerminalAbove(view, pos);
			if (termId) {
				electrobun.rpc!.send.input({ id: termId, data: this.label + "\r" });
			}
		});
		return btn;
	}

	ignoreEvent() {
		return false;
	}
}

function findNearestTerminalAbove(view: EditorView, pos: number): string | null {
	const decos = view.state.field(terminalField);
	let closest: string | null = null;
	let closestPos = -1;
	const iter = decos.iter();
	while (iter.value) {
		if (iter.from <= pos && iter.from > closestPos) {
			const widget = (iter.value.spec as any).widget as TerminalWidget;
			closest = widget.termId;
			closestPos = iter.from;
		}
		iter.next();
	}
	return closest;
}

// --- Button decorations (ViewPlugin scans doc for /button lines) ---

const buttonPattern = /^\/button\s+(.+)$/;

const buttonDecorations = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = this.build(update.view);
			}
		}

		build(view: EditorView): DecorationSet {
			const widgets: Range<Decoration>[] = [];
			for (let i = 1; i <= view.state.doc.lines; i++) {
				const line = view.state.doc.line(i);
				const match = line.text.match(buttonPattern);
				if (match) {
					const deco = Decoration.replace({
						widget: new ButtonWidget(match[1]),
					});
					widgets.push(deco.range(line.from, line.to));
				}
			}
			return Decoration.set(widgets);
		}
	},
	{ decorations: (v) => v.decorations },
);

// --- Slash command completion ---

function slashCommandCompletion(context: CompletionContext) {
	const line = context.state.doc.lineAt(context.pos);
	const textBefore = line.text.slice(0, context.pos - line.from);
	const match = textBefore.match(/^(\s*\/\w*)$/);
	if (!match) return null;

	const from = line.from + match.index!;
	return {
		from,
		options: [
			{
				label: "/button",
				detail: "Embed a command button",
				apply: "/button ",
			},
			{
				label: "/term",
				detail: "Embed inline terminal",
				apply: (view: EditorView, _completion: any, from: number, to: number) => {
					const line = view.state.doc.lineAt(from);
					electrobun
						.rpc!.request.createTerminal({ cols: 80, rows: 10 })
						.then(({ id }) => {
							view.dispatch({
								changes: { from: line.from, to: line.to, insert: "" },
								effects: addTerminalEffect.of({ pos: line.from, id }),
							});
						});
				},
			},
			{
				label: "/duplicate",
				detail: "Duplicate terminal with same cwd",
				apply: (view: EditorView, _completion: any, from: number, to: number) => {
					const line = view.state.doc.lineAt(from);
					const termId = findNearestTerminalAbove(view, from);
					if (!termId) return;
					electrobun.rpc!.request.getCwd({ id: termId }).then(({ cwd }) => {
						electrobun
							.rpc!.request.createTerminal({ cols: 80, rows: 10, cwd: cwd ?? undefined })
							.then(({ id }) => {
								view.dispatch({
									changes: { from: line.from, to: line.to, insert: "" },
									effects: addTerminalEffect.of({ pos: line.from, id }),
								});
							});
					});
				},
			},
		],
	};
}

// --- /term execution and focus ---

function findTerminalAtLine(view: EditorView, lineFrom: number): string | null {
	const decos = view.state.field(terminalField);
	const iter = decos.iter();
	while (iter.value) {
		// Widget is attached at a position; check if it's on the same line
		const widgetLine = view.state.doc.lineAt(iter.from);
		if (widgetLine.from === lineFrom) {
			const widget = (iter.value.spec as any).widget as TerminalWidget;
			return widget.termId;
		}
		iter.next();
	}
	// Also check the line above (widget might be at end of previous line)
	if (lineFrom > 0) {
		const prevLine = view.state.doc.lineAt(lineFrom - 1);
		const iter2 = decos.iter();
		while (iter2.value) {
			if (iter2.from === prevLine.from || iter2.from === prevLine.to) {
				const widget = (iter2.value.spec as any).widget as TerminalWidget;
				return widget.termId;
			}
			iter2.next();
		}
	}
	return null;
}

function focusTerminal(termId: string): boolean {
	const cached = terminalCache.get(termId);
	if (cached) {
		cached.term.focus();
		return true;
	}
	return false;
}

function handleEnter(view: EditorView): boolean {
	const { state } = view;
	const line = state.doc.lineAt(state.selection.main.head);

	// Execute /term command
	if (line.text.trim() === "/term") {
		electrobun
			.rpc!.request.createTerminal({ cols: 80, rows: 10 })
			.then(({ id }) => {
				view.dispatch({
					changes: { from: line.from, to: line.to, insert: "" },
					effects: addTerminalEffect.of({ pos: line.from, id }),
				});
			});
		return true;
	}

	// Execute /duplicate command
	if (line.text.trim() === "/duplicate") {
		const termId = findNearestTerminalAbove(view, line.from);
		if (!termId) return false;
		electrobun.rpc!.request.getCwd({ id: termId }).then(({ cwd }) => {
			electrobun
				.rpc!.request.createTerminal({ cols: 80, rows: 10, cwd: cwd ?? undefined })
				.then(({ id }) => {
					view.dispatch({
						changes: { from: line.from, to: line.to, insert: "" },
						effects: addTerminalEffect.of({ pos: line.from, id }),
					});
				});
		});
		return true;
	}

	// Focus terminal if widget exists at current line
	// Widget is on the next line
	if (line.to < state.doc.length) {
		const nextLine = state.doc.lineAt(line.to + 1);
		const termId = findTerminalAtLine(view, nextLine.from);
		if (termId) return focusTerminal(termId);
	}

	return false;
}

const termCommand = keymap.of([
	{ key: "Enter", run: handleEnter },
]);

// --- Terminal focus highlight on cursor proximity ---

function getAdjacentTermId(view: EditorView): string | null {
	const { state } = view;
	const line = state.doc.lineAt(state.selection.main.head);
	if (line.to < state.doc.length) {
		const nextLine = state.doc.lineAt(line.to + 1);
		return findTerminalAtLine(view, nextLine.from);
	}
	return null;
}

const termFocusHighlight = ViewPlugin.fromClass(
	class {
		prevTermId: string | null = null;

		update(update: ViewUpdate) {
			if (!update.selectionSet) return;
			const termId = getAdjacentTermId(update.view);

			if (termId !== this.prevTermId) {
				// Remove previous highlight
				if (this.prevTermId) {
					const prev = terminalCache.get(this.prevTermId);
					if (prev) prev.element.classList.remove("focused");
				}
				// Add new highlight
				if (termId) {
					const cur = terminalCache.get(termId);
					if (cur) cur.element.classList.add("focused");
				}
				this.prevTermId = termId;
			}
		}
	},
);

// --- CodeMirror ---

const editorContainer = document.getElementById("editor")!;

// Auto-save on changes (debounced)
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
const autoSave = EditorView.updateListener.of((update) => {
	if (!update.docChanged) return;
	if (saveTimeout) clearTimeout(saveTimeout);
	saveTimeout = setTimeout(() => {
		const content = cmView.state.doc.toString();
		electrobun.rpc!.request.saveDoc({ content });
	}, 500);
});

cmView = new EditorView({
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
		autocompletion({
			override: [slashCommandCompletion],
			activateOnTyping: true,
		}),
		terminalField,
		buttonDecorations,
		termFocusHighlight,
		autoSave,
		Prec.highest(termCommand),
	],
	parent: editorContainer,
});

// Load saved document on startup
electrobun.rpc!.request.loadDoc({}).then(({ content }) => {
	if (content !== null) {
		cmView.dispatch({
			changes: { from: 0, to: cmView.state.doc.length, insert: content },
		});
	}
});
