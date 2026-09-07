import { randomBytes } from 'crypto';
import { WebsiteBookmark } from '../types';
import { enqueueWrite, loadWebsites, replaceWebsites } from '../db/store';

function genId(): string {
  return randomBytes(8).toString('hex');
}

export function normalizeWebsiteUrl(raw: string): string {
  let value = String(raw || '').trim();
  if (!value) throw new Error('Informe a URL do site');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL inválida');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('A URL deve começar com http:// ou https://');
  }
  if (!parsed.hostname) throw new Error('URL inválida');

  return parsed.toString();
}

export class WebsitesService {
  private items: WebsiteBookmark[] = [];

  async reload(): Promise<void> {
    this.items = await loadWebsites();
  }

  private save(): void {
    enqueueWrite(() => replaceWebsites(this.items));
  }

  list(): WebsiteBookmark[] {
    return [...this.items].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  create(input: { name: string; url: string; description?: string }): WebsiteBookmark {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Informe o nome do site');
    const url = normalizeWebsiteUrl(input.url);
    const description = String(input.description || '').trim() || undefined;
    const now = Date.now();
    const item: WebsiteBookmark = {
      id: genId(),
      name,
      url,
      description,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(item);
    this.save();
    return item;
  }

  update(
    id: string,
    input: { name?: string; url?: string; description?: string }
  ): WebsiteBookmark {
    const item = this.items.find((w) => w.id === id);
    if (!item) throw new Error('Site não encontrado');
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new Error('Informe o nome do site');
      item.name = name;
    }
    if (input.url !== undefined) item.url = normalizeWebsiteUrl(input.url);
    if (input.description !== undefined) {
      item.description = String(input.description).trim() || undefined;
    }
    item.updatedAt = Date.now();
    this.save();
    return item;
  }

  delete(id: string): void {
    const idx = this.items.findIndex((w) => w.id === id);
    if (idx < 0) throw new Error('Site não encontrado');
    this.items.splice(idx, 1);
    this.save();
  }
}

export const websitesService = new WebsitesService();
