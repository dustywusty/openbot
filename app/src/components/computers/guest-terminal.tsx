import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
const native = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:openbot-desktop|workspace_${command}`, args);
type TerminalEvent =
  | { type: "output"; bytes: number[] }
  | { type: "exit"; code: number };
export function GuestTerminal({ id }: { id: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (!element.current) return;
    let disposed = false;
    let session: string | undefined;
    let input = Promise.resolve();
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, monospace",
      scrollback: 3000,
      theme: {
        background: getComputedStyle(element.current).backgroundColor,
        foreground: getComputedStyle(element.current).color,
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    fit.fit();
    const events = new Channel<TerminalEvent>();
    events.onmessage = (event) => {
      if (disposed) return;
      if (event.type === "output") terminal.write(new Uint8Array(event.bytes));
      else terminal.write(`\r\n[Shell closed: ${event.code}]\r\n`);
    };
    const resize = () => {
      fit.fit();
      if (session)
        void native("terminal_resize", {
          session,
          rows: terminal.rows,
          cols: terminal.cols,
        }).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    const data = terminal.onData((text) => {
      if (!session) return;
      const current = session;
      input = input
        .then(() =>
          native<void>("terminal_write", { session: current, input: text }),
        )
        .catch((error) => {
          if (!disposed) setProblem(String(error));
        });
    });
    void native<string>("terminal_open", { id, onEvent: events })
      .then((opened) => {
        session = opened;
        if (disposed)
          void native("terminal_close", { session }).catch(() => {});
        else {
          resize();
          terminal.focus();
        }
      })
      .catch((error) => {
        if (!disposed) setProblem(String(error));
      });
    return () => {
      disposed = true;
      observer.disconnect();
      data.dispose();
      if (session) void native("terminal_close", { session }).catch(() => {});
      terminal.dispose();
    };
  }, [id]);
  return (
    <div>
      <div className="h-96 w-full" ref={element} />
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}
