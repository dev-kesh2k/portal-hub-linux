/**
 * Valida caminhos absolutos usados em operações de arquivo no WSL.
 */
export function assertSafeAbsolutePath(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed.startsWith('/')) {
    throw new Error('Caminho deve ser absoluto (começar com /)');
  }
  if (trimmed.includes('..') || trimmed.includes('\0')) {
    throw new Error('Caminho inválido');
  }
  if (/["'`$\\;|&<>]/.test(trimmed)) {
    throw new Error('Caminho contém caracteres não permitidos');
  }
  return trimmed;
}

/**
 * Nome de unit systemd / script service (sem injeção de shell).
 */
export function assertSafeServiceName(input: string): string {
  const name = String(input || '').trim();
  if (!name) throw new Error('Nome do serviço inválido');
  if (!/^[a-zA-Z0-9@._+-]+$/.test(name)) {
    throw new Error('Nome do serviço contém caracteres não permitidos');
  }
  return name;
}
