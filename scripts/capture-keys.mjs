process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

console.log("Press keys to inspect their raw terminal sequences.");
console.log("Press Ctrl+C twice to exit.");

let pendingExit = false;

process.stdin.on("data", (chunk) => {
  if (chunk === "\u0003") {
    if (pendingExit) {
      process.exit(0);
    }

    pendingExit = true;
    console.log("CTRL+C");
    return;
  }

  pendingExit = false;

  const bytes = Array.from(Buffer.from(chunk, "utf8"))
    .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
    .join(" ");

  console.log(JSON.stringify({ text: chunk, bytes }));
});
