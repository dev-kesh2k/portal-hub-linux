import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';
import { spawn, IPty } from 'node-pty';
import { Client as SshClient, ClientChannel } from 'ssh2';
import { validateWsAuth } from '../middleware/auth';
import { userService } from '../services/user.service';
import { serverManagerService } from '../services/server-manager.service';
import { AuthUserSession, ServerNode } from '../types';

export interface TerminalSession {
  id: string;
  ws: WebSocket;
  pty: IPty | null;
  sshStream: ClientChannel | null;
  sshClient: SshClient | null;
  session: AuthUserSession;
  serverNode: ServerNode;
  createdAt: number;
}

const sessions = new Map<string, TerminalSession>();

export function setupWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/terminal',
  });

  wss.on('connection', (ws: WebSocket) => {
    const sess = validateWsAuth(ws.protocol);
    if (!sess) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    if (!userService.canAccess(sess, 'terminal', 'full')) {
      ws.close(4403, 'Sem permissão para acessar o terminal');
      return;
    }

    const activeServer = serverManagerService.getActiveServer();
    const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const session: TerminalSession = {
      id: sessionId,
      ws,
      pty: null,
      sshStream: null,
      sshClient: null,
      session: sess,
      serverNode: activeServer,
      createdAt: Date.now(),
    };
    sessions.set(sessionId, session);

    ws.send(
      JSON.stringify({
        type: 'session',
        sessionId,
        user: sess.username,
        role: sess.role,
        permissions: sess.permissions,
        server: {
          id: activeServer.id,
          name: activeServer.name,
          type: activeServer.type,
          host: activeServer.host,
        },
      })
    );

    ws.on('message', (data) => handleMessage(session, data));
    ws.on('close', () => cleanupSession(sessionId));
    ws.on('error', () => cleanupSession(sessionId));
  });

  console.log(`WebSocket server ready on /ws/terminal`);
  return wss;
}

function handleMessage(session: TerminalSession, raw: any): void {
  try {
    const msg = JSON.parse(raw.toString());
    switch (msg.type) {
      case 'init':
        startSessionStream(session, msg.cols, msg.rows);
        break;
      case 'input':
        if (session.pty) {
          session.pty.write(msg.data || '');
        } else if (session.sshStream) {
          session.sshStream.write(msg.data || '');
        }
        break;
      case 'resize':
        const cols = Math.max(10, msg.cols || 80);
        const rows = Math.max(5, msg.rows || 24);
        if (session.pty) {
          session.pty.resize(cols, rows);
        } else if (session.sshStream) {
          try {
            session.sshStream.setWindow(rows, cols, 0, 0);
          } catch {}
        }
        break;
      case 'ping':
        session.ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        break;
      default:
        break;
    }
  } catch {
    if (typeof raw === 'string') {
      if (session.pty) session.pty.write(raw);
      else if (session.sshStream) session.sshStream.write(raw);
    }
  }
}

function startSessionStream(session: TerminalSession, cols: number = 80, rows: number = 24): void {
  const target = session.serverNode || serverManagerService.getActiveServer();

  if (target.type === 'ssh') {
    startSshStream(session, target, cols, rows);
  } else {
    startPtyLocal(session, target, cols, rows);
  }
}

function startSshStream(
  session: TerminalSession,
  server: ServerNode,
  cols: number = 80,
  rows: number = 24
): void {
  try {
    const conn = new SshClient();
    session.sshClient = conn;

    conn.on('ready', () => {
      conn.shell(
        {
          term: 'xterm-256color',
          cols: Math.max(10, cols),
          rows: Math.max(5, rows),
        },
        (err, stream) => {
          if (err) {
            session.ws.send(
              JSON.stringify({
                type: 'error',
                message: `Falha ao iniciar shell SSH: ${err.message}`,
              })
            );
            return;
          }

          session.sshStream = stream;

          stream.on('data', (d: Buffer) => {
            if (session.ws.readyState === WebSocket.OPEN) {
              session.ws.send(JSON.stringify({ type: 'output', data: d.toString('utf8') }));
            }
          });

          stream.on('close', () => {
            if (session.ws.readyState === WebSocket.OPEN) {
              session.ws.send(JSON.stringify({ type: 'exit', code: 0 }));
            }
            cleanupSession(session.id);
          });

          session.ws.send(JSON.stringify({ type: 'ready' }));
        }
      );
    });

    conn.on('error', (err) => {
      session.ws.send(
        JSON.stringify({
          type: 'error',
          message: `Erro de conexão SSH com ${server.host || 'servidor'}: ${err.message}`,
        })
      );
    });

    const connectConfig: any = {
      host: server.host || '127.0.0.1',
      port: server.port || 22,
      username: server.username || 'root',
      readyTimeout: 15000,
      keepaliveInterval: 10000,
    };

    if (server.authType === 'key' && server.privateKey) {
      connectConfig.privateKey = server.privateKey;
    } else if (server.password) {
      connectConfig.password = server.password;
    }

    conn.connect(connectConfig);
  } catch (error: any) {
    session.ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Falha ao conectar via SSH: ' + (error.message || String(error)),
      })
    );
  }
}

function startPtyLocal(
  session: TerminalSession,
  server: ServerNode,
  cols: number = 80,
  rows: number = 24
): void {
  if (session.pty) {
    try { session.pty.kill(); } catch {}
    session.pty = null;
  }

  try {
    const isWin = os.platform() === 'win32';
    let shell: string;
    let args: string[];
    let cwd: string;

    if (isWin && server.type === 'wsl') {
      shell = 'wsl.exe';
      const distro = String(server.wslDistro || process.env.WSL_DISTRO || 'Ubuntu').replace(/"/g, '').trim();
      args = ['-d', distro, '--', 'bash', '-l'];
      cwd = process.cwd();
    } else {
      shell = process.env.SHELL || 'bash';
      args = ['-l'];
      cwd = process.env.HOME || process.cwd();
    }

    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: Math.max(10, cols),
      rows: Math.max(5, rows),
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      } as any,
    });

    session.pty = pty;

    pty.onData((data) => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    pty.onExit((code) => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'exit', code: code.exitCode }));
      }
      cleanupSession(session.id);
    });

    session.ws.send(JSON.stringify({ type: 'ready' }));
  } catch (error: any) {
    session.ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Falha ao iniciar terminal local: ' + (error.message || String(error)),
      })
    );
  }
}

function cleanupSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    if (session.pty) session.pty.kill();
  } catch {}
  try {
    if (session.sshStream) session.sshStream.end();
    if (session.sshClient) session.sshClient.end();
  } catch {}
  sessions.delete(sessionId);
}

export function getActiveSessionCount(): number {
  return sessions.size;
}
