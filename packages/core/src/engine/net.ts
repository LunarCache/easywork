import net from "node:net";

/** 取一个空闲 TCP 端口（绑 127.0.0.1 临时监听后立即释放）。 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 本地推理对外端点（供 /models 发现、外部直连）。 */
export interface LocalEndpoint {
  id: string;
  host: string;
  port: number;
  /** OpenAI/Anthropic 兼容 baseUrl（host=0.0.0.0 时其他设备改用本机局域网 IP）。 */
  baseUrl: string;
}
