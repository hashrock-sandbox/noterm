# noterm

A minimal terminal emulator built with [Electrobun](https://electrobun.dev/) and [xterm.js](https://xtermjs.org/).

## Tech Stack

- **Electrobun** - Lightweight desktop app framework (Bun + native webview)
- **xterm.js** - Terminal UI in the browser
- **bun-pty** - PTY (pseudo-terminal) for Bun

## Getting Started

```bash
npm install
npm start
```

## Development

```bash
npm run dev
```

Starts with `--watch` for hot reload.

## Build

```bash
npm run build:canary
```

## Project Structure

```
src/
  bun/index.ts       # Main process: PTY spawn, RPC handlers
  mainview/
    index.ts          # Renderer: xterm.js setup, RPC communication
    index.html        # Entry HTML
    index.css         # Styles
```
