export const MAX_STREAM_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_JOB_OUTPUT_CHARS = 256 * 1024;
export const TRUNCATION_SUFFIX = '\n… [saída truncada por limite de memória]\n';

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars) + TRUNCATION_SUFFIX;
}

export function appendBoundedText(
  current: string,
  addition: string,
  maxChars = MAX_JOB_OUTPUT_CHARS,
): string {
  if (!addition) return current;
  const combined = current + addition;
  if (combined.length <= maxChars) return combined;
  return truncateText(combined, maxChars);
}

export class BoundedBufferCollector {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number = MAX_STREAM_OUTPUT_BYTES) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    if (this.totalBytes <= this.maxBytes) return;

    this.truncated = true;
    const kept: Buffer[] = [];
    let size = 0;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const part = this.chunks[i];
      if (size + part.length > this.maxBytes) break;
      kept.unshift(part);
      size += part.length;
    }
    this.chunks = kept;
    this.totalBytes = size;
  }

  toString(): string {
    const raw = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? raw + TRUNCATION_SUFFIX : raw;
  }
}

export class BoundedStringCollector {
  private value = '';
  private truncated = false;

  constructor(private readonly maxChars: number = MAX_STREAM_OUTPUT_BYTES) {}

  append(chunk: string): void {
    if (this.truncated || !chunk) return;
    this.value += chunk;
    if (this.value.length <= this.maxChars) return;
    this.value = this.value.slice(-this.maxChars);
    this.truncated = true;
  }

  toString(): string {
    return this.truncated ? this.value + TRUNCATION_SUFFIX : this.value;
  }
}
