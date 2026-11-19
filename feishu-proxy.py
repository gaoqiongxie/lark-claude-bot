# -*- coding: utf-8 -*-
"""飞书 API 本地救急代理（无需管理员权限）。

背景：办公网封禁飞书 API 网段（36.151/36.156/223.109），TLS 握手被重置或黑洞；
同 CDN 节点 36.150.233.53 对全部 feishu.cn 子域 SNI 均可用。本代理在 127.0.0.1:8899
提供 HTTP CONNECT，把 *.feishu.cn 强制转发到可用 IP，其余域名直连。

用法（bot 启动脚本中已配置）：
    set HTTPS_PROXY=http://127.0.0.1:8899
Go 系 lark-cli 自动读取 HTTPS_PROXY；Node 侧设 NODE_USE_ENV_PROXY=1。

注意：仅救急用。办公网若长期封禁飞书 API，应推动 IT 放行，或切网络。
"""
import socket
import threading
import time

LISTEN = ("127.0.0.1", 8899)
PINNED_IP = "36.150.233.53"
# 飞书 CDN 主节点，对所有 feishu.cn 子域 SNI 均提供有效 TLS（实测 accounts/open/msg-frontier/www）；
# 办公网封禁 36.151/36.156/223.109 段，因此 feishu.cn 一律钉扎，其余域名直连
PINNED_SUFFIX = (".feishu.cn",)
LOG_FILE = "proxy.log"


def log(msg: str):
    line = f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def pipe(a: socket.socket, b: socket.socket):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(client: socket.socket):
    host = "?"
    try:
        client.settimeout(30)
        req = b""
        while b"\r\n\r\n" not in req:
            chunk = client.recv(65536)
            if not chunk:
                return
            req += chunk
        line = req.split(b"\r\n", 1)[0].decode("ascii", "replace")
        parts = line.split(" ")
        if len(parts) < 2 or parts[0].upper() != "CONNECT":
            client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        host, _, port = parts[1].partition(":")
        port = int(port or 443)
        target_ip = PINNED_IP if host.endswith(PINNED_SUFFIX) else None
        log(f"CONNECT {host}:{port} -> {target_ip or 'direct'}")
        upstream = socket.create_connection(
            (target_ip or host, port) if target_ip else (host, port), timeout=15
        )
        upstream.settimeout(None)  # create_connection 的 15s 握手超时残留在 socket 上，长连接会被误杀
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        client.settimeout(None)
        log(f"ESTABLISHED {host}:{port}")
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        pipe(upstream, client)
    except OSError as e:
        log(f"FAIL {host}: {e}")
    finally:
        try:
            client.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(64)
    print(f"feishu rescue proxy on http://{LISTEN[0]}:{LISTEN[1]} (pin={PINNED_IP})")
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
