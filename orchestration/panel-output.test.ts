import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { capturedArgv, commandOutput, lastPromptMark, plainLine, promptReporting, promptWarning, readOutput, scanOutput } from "./panel-output.ts";

function logWith(content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-output-test-"));
  const file = path.join(dir, "output.log");
  fs.writeFileSync(file, content);
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test("plain lines drop control sequences and keep the final carriage-return overwrite", () => {
  assert.equal(plainLine("\x1b[32mpass\x1b[0m 1.2s: build\r"), "pass 1.2s: build");
  assert.equal(plainLine("\x1b]133;A;click_events=1\x1b\\\x1b]0;title\x07user> \x1b]133;B\x1b\\"), "user> ");
  assert.equal(plainLine("progress 10%\rprogress 50%\rprogress 100%"), "progress 100%");
  assert.equal(plainLine("\x1bP+q696e\x1b\\\x1b(Bdone\x1b="), "done");
});

test("output is read line-wise with offsets, prompt marks, exit status, and without script's header", () => {
  const content = 'Script started on 2026-10-06 [COMMAND="x"]\n'
    + "\x1b]133;C\x07step 1\r\nstep 2\r\n\x1b]133;D;3\x07\x1b]133;A\x07prompt> "
    + '\nScript done on 2026-10-06 [COMMAND_EXIT_CODE="3"]\n';
  const log = logWith(content);
  const size = fs.statSync(log).size;
  const chunk = readOutput(log, 0, size);
  assert.deepEqual(chunk.lines.map((line) => line.text), ["step 1", "step 2", "prompt> "]);
  assert.deepEqual(chunk.marks.map((mark) => [mark.kind, mark.status]), [["C", undefined], ["D", 3], ["A", undefined]]);
  assert.equal(chunk.exitStatus, 3);
  assert.equal(chunk.next, size);
  const second = chunk.lines[1];
  assert.equal(fs.readFileSync(log, "utf8").slice(0, second.end).endsWith("step 2\r\n"), true);

  const partial = readOutput(log, 0, content.indexOf("prompt> ") + 8);
  assert.equal(partial.partial?.text, "prompt> ");
  assert.equal(partial.marks.at(-1)?.kind, "A", "marks on an unfinished prompt line are reported");
  assert.equal(partial.next < partial.partial!.end, true, "the partial line is not consumed");
});

test("the latest prompt mark is found across chunk boundaries and byte offsets include multibyte text", () => {
  const filler = "é".repeat(700_000);
  const content = `${filler}\x1b]133;D;0\x07${filler}\x1b]133;C\x07${"x".repeat(1_100_000)}`;
  const log = logWith(content);
  const mark = lastPromptMark(log, fs.statSync(log).size);
  assert.equal(mark?.kind, "C");
  assert.equal(mark!.end, Buffer.byteLength(`${filler}\x1b]133;D;0\x07${filler}\x1b]133;C\x07`));
  assert.equal(lastPromptMark(log, Buffer.byteLength(`${filler}\x1b]133;D;0\x07`))?.status, 0);
  assert.equal(lastPromptMark(logWith("plain output\n"), 13), undefined);
});

test("captured commands keep their argv and the caller's SHELL", { skip: process.platform !== "linux" }, async () => {
  const argv = capturedArgv(["/bin/sh", "-c", 'printf "%s|%s" "$1" "$SHELL"', "x", "it's"], "/tmp/log");
  assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"]);
  assert.equal(argv[4], "/tmp/log");
  assert.match(argv[5], /exec '\/bin\/sh' '-c' 'printf "%s\|%s" "\$1" "\$SHELL"' 'x' 'it'"'"'s'$/);
  assert.deepEqual(capturedArgv(["a", "b"], "/tmp/log", "darwin"), ["script", "-q", "-F", "/tmp/log", "a", "b"]);
});

test("input is classified by whether a shell reporting its prompt receives it", () => {
  const prompt = "\x1b]133;D;0\x07\x1b]133;A\x07> \x1b]133;B\x07";
  const ssh = `${prompt}\x1b]133;C;cmdline_url=ssh%20-tt%20mac-wire\x07`;
  const remote = `${ssh}Last login\r\nmac> `;
  const log = logWith(remote);
  const size = Buffer.byteLength(remote);
  assert.deepEqual(promptReporting(log, size, Buffer.byteLength(prompt)), { kind: "prompt" }, "the shell was at its prompt");
  assert.deepEqual(promptReporting(log, size, Buffer.byteLength(ssh) - 5), { kind: "prompt" }, "marks followed the input");
  const program = promptReporting(log, size, size);
  assert.deepEqual(program, { kind: "program", command: "ssh -tt mac-wire", mark: Buffer.byteLength(ssh) });
  assert.match(promptWarning(program)!, /Input goes to `ssh -tt mac-wire`, which shows no OSC 133 prompt marks/);
  assert.deepEqual(promptReporting(log, size), program, "without input, the current state is classified");
  assert.match(promptWarning(promptReporting(logWith("mac> "), 5))!, /No OSC 133 prompt marks have appeared/);
  assert.equal(promptWarning({ kind: "prompt" }), undefined);
  const bash = promptReporting(logWith(`${prompt}\x1b]133;C\x07`), Buffer.byteLength(`${prompt}\x1b]133;C\x07`));
  assert.equal(bash.kind === "program" && bash.command, undefined);
  assert.match(promptWarning(bash)!, /Input goes to a running command/);
});

test("a typed line ends at the first command end after it, and its output starts after the echoed line", () => {
  const prompt = "\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07";
  const typed = `${prompt}echo one; false\r\n\x1b[?2004l\r\x1b]133;C\x07one\r\n\x1b[31mtwo\x1b[m\r\n`;
  const content = `${typed}\x1b]133;D;1\x07\x1b]133;A\x07$ \x1b]133;B\x07`;
  const log = logWith(content);
  const input = Buffer.byteLength(prompt);
  const scan = scanOutput(log, input, undefined, input);
  const end = Buffer.byteLength(`${typed}\x1b]133;D;1\x07`);
  assert.deepEqual(scan.found, { outcome: { kind: "prompt", status: 1 }, end });
  assert.equal(commandOutput(log, input, end), "one\ntwo");

  const empty = `${prompt}\r\n\x1b]133;A\x07$ `;
  const emptyEnd = Buffer.byteLength(empty) - 2;
  assert.deepEqual(scanOutput(logWith(empty), input, undefined, input).found, { outcome: { kind: "prompt" }, end: emptyEnd });
  assert.equal(commandOutput(logWith(empty), input, emptyEnd), "", "an empty line has no output");
});

test("command output keeps the last bytes of very long output, starting at a whole line", () => {
  const start = "\x1b]133;C\x07";
  const lines = Array.from({ length: 600_000 }, (_, index) => `line ${index}`).join("\r\n");
  const content = `${start}${lines}\r\n\x1b]133;D;0\x07`;
  const output = commandOutput(logWith(content), 0, Buffer.byteLength(content)).split("\n");
  assert.match(output[0], /^line \d+$/);
  assert.equal(output.at(-1), "line 599999");
  assert.ok(output.length < 600_000, "only the bounded tail is read");
});
