// Electron stub for headless testing of src/main/collab.ts.
// Captures ipcMain.handle registrations so tests can invoke handlers directly.
// The map lives on globalThis: esbuild may inline this stub into the test
// bundle, and the inlined copy must share state with the copy the test
// requires directly.
const handlers = (globalThis.__collabHandlers = globalThis.__collabHandlers || new Map());
module.exports = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  app: { getPath: () => require('os').homedir() },
  __collabHandlers: handlers,
};
