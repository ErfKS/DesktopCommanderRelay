import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { ToolDefinition } from '../shared/protocol.js';

const HOST = 'laravel.wasel.energy';
const INTERACTIVE = 'a, button, input, textarea, select, [role="button"], [role="link"]';
const textSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const idx = { type: 'integer', minimum: 0, maximum: 500 };

export const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: 'browser_open',
    description: 'Open a URL on laravel.wasel.energy in isolated Chrome. Returns a text/interactive snapshot. Use this first for browser work.',
    inputSchema: textSchema({ url: str('HTTPS URL on laravel.wasel.energy') }, ['url']),
  },
  {
    name: 'browser_snapshot',
    description: 'Read the current page title, URL, visible text and interactive controls with indices. No modification.',
    inputSchema: textSchema({}),
  },
  {
    name: 'browser_click',
    description: 'Click an element by selector or index from browser_snapshot. May modify the website; seek user approval for destructive actions.',
    inputSchema: textSchema({ selector: str('CSS selector, optional if index provided'), index: idx }),
  },
  {
    name: 'browser_fill',
    description: 'Fill a form control by CSS selector or index from browser_snapshot. Filling does not submit.',
    inputSchema: textSchema({ selector: str('CSS selector, optional if index provided'), index: idx, value: str('Text to enter') }, ['value']),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll current page in pixels.',
    inputSchema: textSchema({ pixels: { type: 'integer', minimum: -3000, maximum: 3000 } }, ['pixels']),
  },
  {
    name: 'browser_click_at',
    description: 'Click at pixel position in 1365x850 browser viewport, e.g. user click on the screenshot. May modify the website.',
    inputSchema: textSchema({ x: { type: 'integer', minimum: 0, maximum: 1365 }, y: { type: 'integer', minimum: 0, maximum: 850 } }, ['x', 'y']),
  },
  {
    name: 'browser_type',
    description: 'Type text into currently focused input; does not submit.',
    inputSchema: textSchema({ text: str('Text to type') }, ['text']),
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key such as Enter, Tab, Escape or Backspace.',
    inputSchema: textSchema({ key: str('Key name supported by Playwright') }, ['key']),
  },
  {
    name: 'browser_screenshot',
    description: 'Capture screenshot of current browser viewport, as image/jpeg.',
    inputSchema: textSchema({}),
  },
];

function allowedUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== HOST || url.username || url.password || url.port) {
    throw new Error('Only HTTPS pages on laravel.wasel.energy are allowed');
  }
  return url.toString();
}

function result(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pending: Promise<unknown> = Promise.resolve();

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const run = this.pending.then(() => this.dispatch(name, args));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: ['--disable-dev-shm-usage'],
      });
      this.context = await this.browser.newContext({
        viewport: { width: 1365, height: 850 },
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      await this.context.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          let next: URL;
          try { next = new URL(request.url()); } catch { await route.abort(); return; }
          if (next.protocol !== 'https:' || next.hostname.toLowerCase() !== HOST) {
            await route.abort(); return;
          }
        }
        await route.continue();
      });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(12000);
    }
    return this.page!;
  }

  private async snapshot(page: Page): Promise<unknown> {
    const url = page.url();
    const title = await page.title();
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 12500);
    const interactive = await page.locator(INTERACTIVE).evaluateAll((nodes) =>
      nodes.slice(0, 250).map((node, index) => {
        const el = node as HTMLElement;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= innerHeight ||
            rect.right <= 0 || rect.left >= innerWidth || style.visibility === 'hidden' ||
            style.display === 'none' || style.pointerEvents === 'none') return null;
        return {
          index, tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 100),
          id: el.id || undefined,
          type: el.getAttribute('type') || undefined,
          href: el.getAttribute('href') || undefined,
        };
      }).filter(Boolean)
    );
    return result(JSON.stringify({ url, title, body, interactive }, null, 2));
  }

  private locator(page: Page, args: Record<string, unknown>) {
    if (typeof args.selector === 'string' && args.selector.length > 0 && args.selector.length <= 500) {
      return page.locator(args.selector).first();
    }
    if (Number.isInteger(args.index) && (args.index as number) >= 0 && (args.index as number) <= 500) {
      return page.locator(INTERACTIVE).nth(args.index as number);
    }
    throw new Error('Provide a CSS selector or a snapshot index');
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.ensurePage();
    if (name === 'browser_open') {
      if (typeof args.url !== 'string') throw new Error('url is required');
      await page.goto(allowedUrl(args.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
      return this.snapshot(page);
    }
    if (page.url() === 'about:blank') throw new Error('Call browser_open first');
    if (name === 'browser_snapshot') return this.snapshot(page);
    if (name === 'browser_click') {
      await this.locator(page, args).click();
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
      return this.snapshot(page);
    }
    if (name === 'browser_fill') {
      if (typeof args.value !== 'string' || args.value.length > 10000) throw new Error('Invalid value');
      await this.locator(page, args).fill(args.value);
      return result('Field filled. No form submission was performed.');
    }
    if (name === 'browser_scroll') {
      if (!Number.isInteger(args.pixels) || Math.abs(args.pixels as number) > 3000) throw new Error('Invalid pixels');
      await page.mouse.wheel(0, args.pixels as number);
      return this.snapshot(page);
    }
    if (name === 'browser_click_at') {
      if (!Number.isInteger(args.x) || !Number.isInteger(args.y) || (args.x as number) < 0 || (args.x as number) > 1365 || (args.y as number) < 0 || (args.y as number) > 850) throw new Error('Invalid viewport coordinates');
      await page.mouse.click(args.x as number, args.y as number);
      return result('Clicked at viewport coordinates. Request a screenshot or snapshot to inspect results.');
    }
    if (name === 'browser_type') {
      if (typeof args.text !== 'string' || args.text.length > 10000) throw new Error('Invalid typing text');
      await page.keyboard.insertText(args.text);
      return result('Text typed into focused control.');
    }
    if (name === 'browser_press') {
      if (typeof args.key !== 'string' || !['Enter','Tab','Escape','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Home','End'].includes(args.key)) throw new Error('Keyboard key is not allowed');
      await page.keyboard.press(args.key);
      return result('Key pressed.');
    }
    if (name === 'browser_screenshot') {
      const bytes = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
      return { content: [{ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }] };
    }
    throw new Error('Unknown browser tool');
  }
}
