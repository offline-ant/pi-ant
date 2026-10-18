import net from "node:net";

// An owned desktop-opener stand-in that stays alive like a foreground browser.
const socket = net.createConnection(process.env.PI_SWITCH_OPENER_SOCKET);
const watchdog = setTimeout(() => process.exit(1), 15_000);
socket.once("connect", () => {
  socket.write(JSON.stringify({ pid: process.pid, url: process.argv[2] }) + "\n");
  setTimeout(() => socket.write("survived\n"), 5_200);
});
socket.on("error", () => process.exit(1));
socket.on("data", () => socket.end());
socket.once("close", () => { clearTimeout(watchdog); process.exit(0); });
