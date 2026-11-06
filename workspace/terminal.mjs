// Interactive workspace sessions: Pi's process has pipes, not a terminal
// (a pty-spawned process could not also hold the relay's IPC channel). The
// terminal is Studio's xterm, so present stdin and stdout as one: Pi chooses
// interactive mode from isTTY, keystrokes already arrive raw, and Coach sends
// the size over IPC. Nothing is granted; this only describes the streams.
const size = { columns: 80, rows: 24 };

export function presentTerminal() {
  const { stdin, stdout } = process;
  let raw = false;
  Object.defineProperties(stdin, {
    isTTY: { value: true },
    isRaw: { get: () => raw },
  });
  stdin.setRawMode = (mode) => {
    raw = !!mode;
    return stdin;
  };
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { get: () => size.columns },
    rows: { get: () => size.rows },
  });
  stdout.getWindowSize = () => [size.columns, size.rows];
  stdout.getColorDepth = () => 24;
  stdout.hasColors = () => true;
}

/** A size message from Coach: `{ resize: [columns, rows] }`. */
export function resizeTerminal([columns, rows]) {
  if (![columns, rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 500))
    return;
  size.columns = columns;
  size.rows = rows;
  process.stdout.emit("resize");
}
