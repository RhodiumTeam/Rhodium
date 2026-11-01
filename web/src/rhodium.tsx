// Rhodium's own page (product §7): this run, each bot's connection, and its log.
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ago, Back, Box, clock, Heading, Title } from "./common";
import { json, type RhodiumData } from "./data";

const CONN: Record<string, [label: string, edge: string]> = {
  online: ["已连上", "border-l-done"],
  reconnecting: ["重连中", "border-l-needs"],
  faulted: ["故障", "border-l-destructive"],
};

export function RhodiumPage() {
  const { data } = useQuery({ queryKey: ["rhodium"], queryFn: () => json<RhodiumData>("api/rhodium") });
  return data ? <RhodiumView d={data} /> : null;
}

export function RhodiumView({ d }: { d: RhodiumData }) {
  const run = [`第 ${d.boot} 次启动，${ago(d.startedAt)}`, `PID ${d.pid}`, d.unit ? `服务 ${d.unit}` : "不是作为 systemd 服务运行"];
  const log = d.logs && (d.logs.map((l) => `${clock(l.at)} ${l.line}`).join("\n") || "日志是空的。");
  return (
    <>
      <Back />
      <Title sub={run.join("\n")}>Rhodium</Title>
      <Heading>Bot</Heading>
      <ul className="grid gap-1.5">
        {!d.bots.length && <li className="text-sm text-muted-foreground">配置里没有 Bot。</li>}
        {d.bots.map((b) => {
          const [label, edge] = CONN[b.state ?? ""] ?? ["连接中", "border-l-needs"];
          return (
            <li key={b.name} className={cn("flex items-baseline gap-2.5 rounded-lg border border-l-4 bg-card px-2.5 py-2", edge)}>
              <span className="font-medium">{b.name}</span>
              <span className="text-xs text-muted-foreground">{b.platform}</span>
              <span className="ml-auto text-xs">{label}</span>
            </li>
          );
        })}
      </ul>
      <Heading>日志（journald）</Heading>
      <Box>{log ?? "rhodium 不是作为 systemd 服务运行的，日志在它的 stderr 里。"}</Box>
    </>
  );
}
