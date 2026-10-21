import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'DeskBridge Sandbox Browser', version: '1.0.0' });
const $ = (id: string) => document.getElementById(id)!;
const screen = $('screen') as HTMLImageElement;
const status = $('status');
const address = $('address') as HTMLInputElement;
const input = $('typing') as HTMLInputElement;
let busy = false;
function setStatus(message: string) { status.textContent = message; }

async function run(name: string, args: Record<string, unknown> = {}) {
  if (busy) return null;
  busy = true;
  setStatus('Working: ' + name);
  try {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) {
      setStatus(result.content?.find(c => c.type === 'text')?.text ?? 'Tool error');
      return null;
    }
    const message = result.content?.find(c => c.type === 'text')?.text;
    if (message) {
      try {
        const obj = JSON.parse(message);
        if (typeof obj.url === 'string') address.value = obj.url;
        if (typeof obj.title === 'string') setStatus(obj.title);
        else setStatus('Ready');
      } catch { setStatus(message.slice(0, 200)); }
    } else setStatus('Ready');
    return result;
  } catch (error) {
    setStatus('Request failed: ' + String(error));
    return null;
  } finally {
    busy = false;
  }
}

async function refresh() {
  const response = await run('browser_screenshot');
  const image = response?.content?.find(c => c.type === 'image');
  if (image?.type === 'image' && image.data) {
    screen.src = 'data:' + (image.mimeType || 'image/jpeg') + ';base64,' + image.data;
  }
}

async function action(name: string, args: Record<string, unknown> = {}) {
  const response = await run(name, args);
  if (response) await refresh();
}

$('open').addEventListener('click', () => void action('browser_open', { url: address.value }));
$('refresh').addEventListener('click', () => void refresh());
$('scroll-down').addEventListener('click', () => void action('browser_scroll', { pixels: 600 }));
$('scroll-up').addEventListener('click', () => void action('browser_scroll', { pixels: -600 }));
$('send-text').addEventListener('click', () => void action('browser_type', { text: input.value }));
$('enter').addEventListener('click', () => void action('browser_press', { key: 'Enter' }));
screen.addEventListener('click', (event) => {
  const bounds = screen.getBoundingClientRect();
  const x = Math.round((event.clientX - bounds.left) * (1365 / bounds.width));
  const y = Math.round((event.clientY - bounds.top) * (850 / bounds.height));
  void action('browser_click_at', { x, y });
});
app.ontoolresult = (result) => {
  const message = result.content?.find(c => c.type === 'text')?.text;
  if (message) {
    try {
      const parsed = JSON.parse(message);
      if (typeof parsed.url === 'string') address.value = parsed.url;
    } catch {}
  }
};
app.connect().then(() => action('browser_open', { url: address.value }))
  .catch(e => setStatus('MCP Apps connection failed: ' + String(e)));
