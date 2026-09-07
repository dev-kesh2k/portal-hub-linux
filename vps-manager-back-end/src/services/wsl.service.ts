import { exec, spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { WslCommandRequest, WslCommandResponse, WslInfo, SystemStats } from '../types';
import { BoundedBufferCollector, MAX_STREAM_OUTPUT_BYTES } from '../lib/output-buffer';

const execAsync = promisify(exec);

function isUtf16Le(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  let pairs = 0;
  const max = Math.min(buf.length, 4096);
  for (let i = 0; i + 1 < max; i += 2) {
    if (buf[i + 1] === 0 && buf[i] !== 0) pairs++;
  }
  return pairs > Math.floor(max / 8);
}

function decodeBuffer(buf: any): string {
  if (Buffer.isBuffer(buf)) {
    if (isUtf16Le(buf)) {
      try {
        let clean = buf;
        if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) clean = buf.slice(2);
        return clean.toString('utf16le').replace(/\r\n/g, '\n');
      } catch {}
    }
    let s = buf.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    if (s.includes('\u0000')) {
      try { return buf.toString('utf16le').replace(/\r\n/g, '\n'); } catch {}
    }
    return s.replace(/\r\n/g, '\n');
  }
  return String(buf || '');
}

function cleanStdout(raw: any): string {
  const str = decodeBuffer(raw);
  if (!str) return '';
  let out = str;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  out = out.replace(/\r\n/g, '\n');
  return out;
}

export class WslService {
  private distro: string;

  constructor(distro: string = process.env.WSL_DISTRO || 'Ubuntu') {
    this.distro = distro;
  }

  private normalizeUsername(username?: string): string | undefined {
    const clean = String(username || '').trim().replace(/^@+/, '');
    return clean ? clean : undefined;
  }

  private isNativeLinux(): boolean {
    return process.platform === 'linux';
  }

  private buildWslCommand(command: string, workingDirectory?: string, username?: string): string {
    const cdPrefix = workingDirectory ? `cd ${this.escapePath(workingDirectory)} && ` : '';
    if (this.isNativeLinux()) {
      const userArg = this.normalizeUsername(username);
      const inner = JSON.stringify(cdPrefix + command);
      if (userArg) {
        // Só usa runuser se o usuário Linux existir; AUTH_USERNAME do Hub muitas vezes não existe.
        return `if id ${JSON.stringify(userArg)} >/dev/null 2>&1; then runuser -u ${JSON.stringify(userArg)} -- bash -lc ${inner}; else bash -lc ${inner}; fi`;
      }
      return `bash -lc ${inner}`;
    }
    const distro = String(this.distro).replace(/"/g, '').trim();
    const userArg = this.normalizeUsername(username);
    return `wsl.exe -d ${distro}${userArg ? ` -u ${userArg}` : ''} -- bash -c ${JSON.stringify(cdPrefix + command)}`;
  }

  /**
   * wsl.exe treats $VAR in argv as Windows env interpolation. Unset vars become
   * empty, which breaks bash (`$file` → `""` → "No such file or directory").
   * Escape identifiers so bash still expands them; leave $(...) and $1/$?.
   */
  private escapeWslArgvDollars(command: string): string {
    return String(command || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => '\\${' + name + '}')
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => '\\$' + name);
  }

  private escapePath(path: string): string {
    return path.replace(/'/g, `'\\''`).replace(/"/g, '\\"');
  }

  async executeCommand(req: WslCommandRequest): Promise<WslCommandResponse> {
    const startTime = Date.now();
    const timeout = req.timeout || 60000;

    try {
      const fullCmd = this.buildWslCommand(req.command, req.workingDirectory, req.username);
      const { stdout, stderr } = await execAsync(fullCmd, {
        timeout,
        maxBuffer: MAX_STREAM_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'buffer' as any,
      });

      return {
        success: true,
        stdout: cleanStdout(stdout) || '',
        stderr: cleanStdout(stderr) || '',
        exitCode: 0,
        executionTimeMs: Date.now() - startTime,
        command: req.command,
      };
    } catch (error: any) {
      return {
        success: false,
        stdout: cleanStdout(error.stdout || '') || '',
        stderr: cleanStdout(error.stderr || '') || error.message || String(error),
        exitCode: typeof error.code === 'number' ? error.code : 1,
        executionTimeMs: Date.now() - startTime,
        command: req.command,
      };
    }
  }

  async executeCommandStdin(
    req: WslCommandRequest,
    stdinPayload?: string
  ): Promise<WslCommandResponse> {
    const startTime = Date.now();
    const timeout = req.timeout || 60000;
    return new Promise<WslCommandResponse>((resolve) => {
      let resolved = false;
      let timer: any = null;
      const distro = String(this.distro).replace(/"/g, '').trim();
      const userArg = this.normalizeUsername(req.username);
      const inner = req.workingDirectory
        ? `cd ${this.escapePath(req.workingDirectory)} && ${req.command}`
        : req.command;
      const child = this.isNativeLinux()
        ? spawn('bash', ['-lc', inner], { stdio: 'pipe' })
        : spawn(
            'wsl.exe',
            [
              '-d',
              distro,
              ...(userArg ? ['-u', userArg] : []),
              '--',
              'bash',
              '-c',
              this.escapeWslArgvDollars(inner),
            ],
            { windowsHide: true, stdio: 'pipe' }
          );
      const stdoutCollector = new BoundedBufferCollector();
      const stderrCollector = new BoundedBufferCollector();
      let exitCode = 0;

      const finish = (force?: boolean) => {
        if (resolved) return;
        resolved = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (force) {
          try { child.kill('SIGTERM'); } catch {}
        }
        resolve({
          success: exitCode === 0,
          stdout: cleanStdout(stdoutCollector.toString()) || '',
          stderr: cleanStdout(stderrCollector.toString()) || '',
          exitCode,
          executionTimeMs: Date.now() - startTime,
          command: req.command,
        });
      };

      timer = setTimeout(() => {
        stderrCollector.push(Buffer.from(`\nTimeout after ${timeout}ms\n`));
        exitCode = 124;
        finish(true);
      }, timeout);

      child.stdout?.on('data', (d: Buffer) => stdoutCollector.push(d));
      child.stderr?.on('data', (d: Buffer) => stderrCollector.push(d));
      child.on('error', (err: any) => {
        stderrCollector.push(Buffer.from(String(err?.message || err)));
        exitCode = 1;
        finish();
      });
      child.on('close', (code: number | null) => {
        exitCode = typeof code === 'number' ? code : 0;
        finish();
      });

      if (stdinPayload && child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write(stdinPayload);
          child.stdin.end();
        } catch {
          try { child.stdin.end(); } catch {}
        }
      } else if (child.stdin) {
        try { child.stdin.end(); } catch {}
      }
    });
  }

  async getCurrentLinuxUser(): Promise<string | null> {
    try {
      const result = await this.executeCommand({ command: 'whoami' });
      const user = result.stdout.trim();
      return user || null;
    } catch {
      return null;
    }
  }

  private toLinuxPath(windowsOrPosixPath: string): string {
    const normalized = path.resolve(windowsOrPosixPath).replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
    return normalized;
  }

  private authMarkerFound(output: string): boolean {
    return output.replace(/\r/g, '').split('\n').some((line) => line.trim() === '__HUB_AUTH_OK__');
  }

  async linuxUserExists(username?: string): Promise<boolean> {
    const user = this.normalizeUsername(username);
    if (!user) return false;
    const result = await this.executeCommand({
      command: `getent passwd ${JSON.stringify(user)} >/dev/null 2>&1; echo $?`,
    });
    return result.stdout.trim() === '0';
  }

  async authenticateLinuxUser(username: string, password: string): Promise<boolean> {
    const user = this.normalizeUsername(username);
    if (!user || !password) return false;
    if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user)) return false;

    const script = this.toLinuxPath(path.resolve(__dirname, '..', '..', 'scripts', 'linux-pam-auth.py'));
    const pam = await this.executeCommandStdin(
      {
        command: `python3 ${JSON.stringify(script)} ${JSON.stringify(user)}`,
        timeout: 15000,
      },
      `${password}\n`
    );
    if (pam.success && pam.stdout.trim() === 'ok') return true;

    const su = await this.executeCommandStdin(
      {
        command: `su - ${JSON.stringify(user)} -c ${JSON.stringify("printf '__HUB_AUTH_OK__\\n'")}`,
        timeout: 15000,
      },
      `${password}\n`
    );
    return this.authMarkerFound(su.stdout) || this.authMarkerFound(su.stderr);
  }

  async getWslInfo(): Promise<WslInfo> {
    try {
      let stdout = '';
      try {
        const r = await execAsync(`wsl.exe -l -v --no-header`, { windowsHide: true, encoding: 'buffer' as any });
        stdout = cleanStdout(r.stdout);
      } catch {
        const r = await execAsync(`wsl.exe -l -v`, { windowsHide: true, encoding: 'buffer' as any });
        stdout = cleanStdout(r.stdout);
      }
      const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

      let distroInfo: WslInfo = {
        distro: this.distro,
        state: 'Unknown',
        version: 'Unknown',
      };

      for (const line of lines) {
        if (/^NAME\s+STATE\s+VERSION/i.test(line)) continue;
        const cleanLine = line.replace(/^\*\s*/, '');
        const match = cleanLine.match(/^(\S+)\s+(Running|Stopped)\s+([\d\.]+)/i);
        if (match && match[1].toLowerCase() === this.distro.toLowerCase()) {
          distroInfo = {
            distro: match[1],
            state: match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase(),
            version: match[3],
          };
          break;
        }
      }

      try {
        const kernelResult = await this.executeCommand({ command: 'uname -r' });
        distroInfo.kernel = kernelResult.stdout.trim();
      } catch {}

      try {
        const uptimeResult = await this.executeCommand({ command: 'uptime -p 2>/dev/null || uptime' });
        distroInfo.uptime = uptimeResult.stdout.trim();
      } catch {}

      return distroInfo;
    } catch (error: any) {
      return {
        distro: this.distro,
        state: 'Error',
        version: 'Unknown',
        uptime: error.message || String(error),
      };
    }
  }

  async getSystemStats(): Promise<SystemStats> {
    const s: SystemStats = {
      cpuUsage: 0, memoryUsedGB: 0, memoryTotalGB: 0, memoryPercent: 0,
      diskUsedGB: 0, diskTotalGB: 0, diskPercent: 0,
      runningProcesses: 0, networkRxMB: 0, networkTxMB: 0,
    };
    try {
      const freeRaw = await this.executeCommand({ command: `free -k` });
      const freeLines = freeRaw.stdout.split('\n').filter((l: string) => l.trim());
      const memLine = freeLines.find((l: string) => /^Mem:\s+/i.test(l.trim()));
      if (memLine) {
        const mf = memLine.trim().split(/\s+/);
        const totKB = parseInt(mf[1]) || 0;
        const usedKB = parseInt(mf[2]) || 0;
        const buffKB = parseInt(mf[5]) || 0;
        if (totKB > 0) {
          const effUsed = usedKB + buffKB;
          s.memoryTotalGB = +(totKB / 1024 / 1024).toFixed(3);
          s.memoryUsedGB = +(effUsed / 1024 / 1024).toFixed(3);
          s.memoryPercent = +((effUsed / totKB) * 100).toFixed(1);
        }
      }

      const dfRaw = await this.executeCommand({ command: `df -Pk /` });
      const dfLines = dfRaw.stdout.split('\n').filter((l: string) => l.trim());
      const dfLine = dfLines.find((l: string) => !/^Filesystem\s+/i.test(l.trim()));
      if (dfLine) {
        const df = dfLine.trim().split(/\s+/);
        const totK = parseInt(df[1]) || 0;
        const usdK = parseInt(df[2]) || 0;
        const pctRaw = df[4] || '';
        const pct = parseInt(String(pctRaw).replace('%', '')) || 0;
        if (totK > 0) {
          s.diskTotalGB = +(totK / 1024 / 1024).toFixed(2);
          s.diskUsedGB = +(usdK / 1024 / 1024).toFixed(2);
          s.diskPercent = pct || +((usdK / totK) * 100).toFixed(0);
        }
      }

      try {
        function parseCpuLine(out: string): [number, number] | null {
          const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('cpu '));
          if (!line) return null;
          const f = line.split(/\s+/).slice(1).map(parseFloat);
          if (f.length < 8) return null;
          const [user, nice, sys, idle, iowait, irq, softirq, steal] = f;
          const idd = idle + iowait;
          const tot = user + nice + sys + idle + iowait + irq + softirq + (steal || 0);
          return [tot, idd];
        }
        const cpu1 = await this.executeCommand({ command: `grep '^cpu ' /proc/stat` });
        const a = parseCpuLine(cpu1.stdout);
        await new Promise((r) => setTimeout(r, 500));
        const cpu2 = await this.executeCommand({ command: `grep '^cpu ' /proc/stat` });
        const b = parseCpuLine(cpu2.stdout);
        if (a && b) {
          const td = b[0] - a[0];
          const id = b[1] - a[1];
          if (td > 0) s.cpuUsage = +(100 * (1 - id / td)).toFixed(1);
        }
      } catch {}

      try {
        const procRaw = await this.executeCommand({ command: `ls /proc 2>/dev/null | grep -cE '^[0-9]+$'` });
        s.runningProcesses = parseInt(procRaw.stdout.trim()) || 0;
      } catch {}

      try {
        const netRaw = await this.executeCommand({ command: `cat /proc/net/dev` });
        const netLines = netRaw.stdout.split('\n').filter((l: string) => l.includes(':'));
        let rx = 0, tx = 0;
        for (const nl of netLines) {
          const parts = nl.trim().split(':');
          if (parts.length < 2) continue;
          const iface = parts[0].trim();
          if (iface === 'lo') continue;
          const rest = parts.slice(1).join(':').trim().split(/\s+/);
          if (rest.length >= 9) {
            rx += parseFloat(rest[0]) || 0;
            tx += parseFloat(rest[8]) || 0;
          }
        }
        s.networkRxMB = +(rx / 1024 / 1024).toFixed(3);
        s.networkTxMB = +(tx / 1024 / 1024).toFixed(3);
      } catch {}

      return s;
    } catch {
      return s;
    }
  }

  async listRunningServices(): Promise<any[]> {
    try {
      const systemctlResult = await this.executeCommand({
        command: `systemctl list-units --type=service --no-pager --no-legend --plain 2>/dev/null | awk 'NF>=4'`,
        timeout: 15000,
      });
      if (systemctlResult.stdout.trim()) {
        const lines = systemctlResult.stdout.split('\n').filter((l: string) => l.trim());
        const out: any[] = [];
        for (const line of lines) {
          const trimmed = line.replace(/^●\s*/, '').trim();
          const m = trimmed.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]*)$/);
          if (m) {
            out.push({
              name: m[1].replace(/\.service$/, ''),
              load: m[2],
              active: m[3],
              sub: m[4],
              description: (m[5] || '').trim(),
            });
          } else {
            const parts = trimmed.split(/\s+/).filter(Boolean);
            if (parts.length >= 4) {
              out.push({
                name: parts[0].replace(/\.service$/, ''),
                load: parts[1],
                active: parts[2],
                sub: parts[3],
                description: parts.slice(4).join(' '),
              });
            }
          }
          if (out.length >= 100) break;
        }
        return out;
      }

      const svcResult = await this.executeCommand({
        command: `service --status-all 2>/dev/null || echo "SERVICE_MANAGER_NOT_FOUND"`,
      });
      if (svcResult.stdout.includes('SERVICE_MANAGER_NOT_FOUND')) return [];
      const lines = svcResult.stdout.split('\n').filter((l: string) => l.trim());
      return lines.slice(0, 100).map((line: string) => {
        const m = line.match(/\[\s*([\?+-])\s*\]\s*(.+)/);
        if (m) {
          const status = m[1] === '+' ? 'active/running' : m[1] === '-' ? 'inactive/stopped' : 'unknown';
          return {
            name: m[2].trim(),
            load: 'loaded',
            active: status.split('/')[0],
            sub: status.split('/')[1] || '',
            description: '',
          };
        }
        return { name: line.trim(), load: '', active: '', sub: '', description: '' };
      });
    } catch {
      return [];
    }
  }

  async getRecentLogs(rows: number = 100): Promise<string[]> {
    try {
      const r = Math.max(1, Math.min(rows, 2000));
      const result = await this.executeCommand({
        command: `(journalctl -n ${r} --no-pager 2>/dev/null || (dmesg 2>/dev/null | tail -n ${r}) || (cat /var/log/syslog 2>/dev/null | tail -n ${r}) || echo "NO_LOGS_AVAILABLE") | tail -n ${r}`,
        timeout: 15000,
      });
      return result.stdout
        .split('\n')
        .filter((l: string) => l.trim() && !l.includes('NO_LOGS_AVAILABLE'));
    } catch {
      return [];
    }
  }

  async listFiles(path: string = '/'): Promise<any[]> {
    try {
      const safePath = path.replace(/"/g, '').replace(/`/g, '\\`').replace(/\\/g, '/');
      const result = await this.executeCommand({
        command: `ls -la --time-style="+%Y-%m-%d %H:%M" "${safePath}" 2>/dev/null`,
        timeout: 15000,
      });
      const lines = result.stdout.split('\n').filter((l: string) => l.trim());
      const rows: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === 0 && /^total\s+/i.test(line.trim())) continue;
        const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+([\s\S]*)$/);
        if (m) {
          rows.push({
            perms: m[1] || '',
            links: m[2] || '',
            owner: m[3] || '',
            group: m[4] || '',
            size: m[5] || '',
            date: m[6] || '',
            name: (m[7] || '').trim(),
          });
        }
      }
      return rows;
    } catch {
      return [];
    }
  }
}

export const wslService = new WslService();
