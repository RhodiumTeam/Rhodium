// Connect exactly as the browser terminal does. Only binary frames carry pane bytes.
export function terminalSocket(origin: string, slot: string) {
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/api/terminal?slot=" + slot + "&cols=80&rows=24", { headers: { Origin: origin } } as any);
  ws.binaryType = "arraybuffer";
  let output = "";
  ws.onmessage = e => { if (e.data instanceof ArrayBuffer) output += new TextDecoder().decode(e.data); };
  const closed = new Promise<number>(resolve => { ws.onclose = e => { console.log("WS close", e.code, e.reason); resolve(e.code); }; });
  async function wait(marker: string) {
    for (let i = 0; i < 120; i++) {
      if (output.includes(marker)) return;
      if (ws.readyState === WebSocket.CLOSED) break;
      await Bun.sleep(100);
    }
    throw new Error("missing binary frame marker " + marker);
  }
  return { ws, wait, closed };
}
