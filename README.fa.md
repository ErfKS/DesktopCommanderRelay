# DesktopCommanderRelay

DesktopCommanderRelay یک پل self-hosted است که یک پردازش محلی DesktopCommanderMCP را در اختیار کلاینت‌های راه‌دور MCP و، به‌صورت اختیاری، کلاینت‌های HTTP Action احراز هویت‌شده مانند یک Custom GPT در ChatGPT قرار می‌دهد. Relay Server روی یک سرور اجرا می‌شود، Relay Agent روی کامپیوتری که قرار است کنترل شود اجرا می‌شود، و Agent، DesktopCommanderMCP را از طریق انتقال استاندارد MCP مبتنی بر stdio اجرا می‌کند.

این پروژه یک Relay مستقل است. سرویس خصوصی و upstream مربوط به Desktop Commander را شبیه‌سازی یا کپی نمی‌کند و نیازی به patch کردن DesktopCommanderMCP نیست.

## معماری

DesktopCommanderRelay از دو مسیر ورودی راه‌دور پشتیبانی می‌کند که از یک Relay Server و Agent انتخاب‌شدهٔ مشترک استفاده می‌کنند.

```text
Remote MCP client                         ChatGPT Custom GPT / Action client
        |                                             |
        | Streamable HTTP MCP + MCP_API_KEY           | HTTPS REST + ACTION_API_KEY
        v                                             v
                    Relay Server (remote server)
                              |
                               | WebSocket + AGENT_TOKEN
                              v
                    Relay Agent (controlled computer)
                              |
                               | stdio MCP
                              v
                    DesktopCommanderMCP
```

مسیر MCP و مسیر Action دارای credentialها و مرزهای اعتماد جداگانه هستند:

- `MCP_API_KEY` درخواست‌های ورودی به endpoint مربوط به MCP را احراز هویت می‌کند.
- `ACTION_API_KEY` درخواست‌های ورودی به HTTP Action API را احراز هویت می‌کند.
- `AGENT_TOKEN` اتصال Relay Agentها از طریق WebSocket را احراز هویت می‌کند.

Agent اتصال WebSocket را با Server حفظ می‌کند و فراخوانی ابزارهای انتخاب‌شده را به پردازش محلی DesktopCommanderMCP منتقل می‌کند.

## شروع سریع

مسیر استاندارد استقرار به این صورت است: Docker Compose برای Relay Server و Agent ساخته‌شده با Node.js روی کامپیوتری که قرار است کنترل شود. فایل Compose سمت سرور، Node را فقط روی `127.0.0.1:8787` منتشر می‌کند؛ بنابراین باید یک reverse proxy با TLS در جلوی آن قرار دهید.

endpoint مربوط به MCP را می‌توان بدون فعال کردن ChatGPT Action API استفاده کرد. Action API یک رابط احراز هویت‌شدهٔ اضافه برای همان Agent انتخاب‌شده است.

### 1. پیش‌نیازها

روی سرور:

- Docker Engine به‌همراه Docker Compose plugin
- Node.js نسخه 20 یا جدیدتر و npm برای اجرای secret generator موجود در repository
- یک DNS عمومی مانند `relay.example.com`
- یک TLS reverse proxy برای خاتمه دادن HTTPS/WSS

روی کامپیوتری که قرار است کنترل شود:

- Node.js نسخه 20 یا جدیدتر و npm
- DesktopCommanderMCP که یا به‌صورت فرمان `desktop-commander` در دسترس باشد، یا به‌صورت sibling checkout ساخته‌شده موجود باشد، یا مسیر ورودی آن صراحتاً مشخص شده باشد

این repository عملیات تهیه DNS یا صدور certificateهای TLS را انجام نمی‌دهد.

### 2. نصب Relay Server

دستورهای زیر را روی سرور اجرا کنید. مقدار `<repository-url>` را با URL repository مورد استفادهٔ خود جایگزین کنید؛ این پروژه URL clone ثابتی را داخل کد قرار نمی‌دهد.

```bash
git clone <repository-url> DesktopCommanderRelay
cd DesktopCommanderRelay
cp .env.example .env
```

فرآیند Compose build، dependencyهای production را نصب می‌کند و image سمت Server را می‌سازد. در این مرحله Node.js روی خود Host فقط برای اجرای `npm run secrets` لازم است؛ خود Server داخل image ساخته و اجرا می‌شود.

### 3. ساخت و پیکربندی credentialهای سرور

credentialهای مستقل MCP و Agent را تولید کنید:

```text
npm run secrets
```

دو خط خروجی را داخل `.env` قرار دهید. مقادیر باید با هم متفاوت باشند:

```env
MCP_API_KEY=<generated-mcp-api-key>
AGENT_TOKEN=<different-generated-agent-token>
```

اگر می‌خواهید Action API سازگار با ChatGPT را هم فعال کنید، یک secret مستقل سوم تولید کنید. برای مثال روی سیستمی که OpenSSL دارد:

```bash
openssl rand -hex 32
```

آن را به `.env` سمت Server اضافه کنید:

```env
ACTION_API_KEY=<different-generated-action-api-key>
```

از یک مقدار مشترک برای `MCP_API_KEY`، `ACTION_API_KEY` یا `AGENT_TOKEN` استفاده نکنید.

برای یک hostname عمومی که هم MCP و هم Actions روی آن فعال باشند، حداقل تنظیمات Server به این شکل است:

```env
MCP_API_KEY=<generated-mcp-api-key>
ACTION_API_KEY=<different-generated-action-api-key>
AGENT_TOKEN=<different-generated-agent-token>
TARGET_DEVICE_ID=home-pc
MCP_ALLOWED_HOSTS=relay.example.com
ALLOW_INSECURE_LOCAL=false
```

فایل Compose مقدار `HOST` را داخل container روی `0.0.0.0` override می‌کند و port کانتینر را روی `127.0.0.1:8787` منتشر می‌کند. مگر اینکه mapping مربوط به Compose و upstream مربوط به reverse proxy را هم تغییر دهید، `PORT=8787` را حفظ کنید. مقدار `MCP_ALLOWED_HOSTS` باید hostname عمومی ارسال‌شده توسط proxy باشد، بدون scheme و port.

### 4. اجرای Relay Server

روی سرور اجرا کنید:

```bash
docker compose up -d --build
docker compose logs -f relay
```

Server داخل container روی port `8787` گوش می‌دهد. URL عمومی MCP معمولاً به این صورت خواهد بود:

```text
https://relay.example.com/mcp
```

در صورت فعال بودن، مسیر پایهٔ Action API معمولاً به این صورت خواهد بود:

```text
https://relay.example.com/action
```

Agent به هیچ‌کدام از endpointهای HTTP مخصوص client وصل نمی‌شود؛ بلکه از URL مربوط به WebSocket که در مرحله 7 آمده استفاده می‌کند.

### 5. پیکربندی TLS و reverse proxy

certificate را جداگانه تهیه کنید، سپس routeهای موجود در [`deploy/nginx.conf.example`](deploy/nginx.conf.example) را داخل HTTPS server block مربوط به `relay.example.com` قرار دهید.

Proxy باید موارد زیر را forward کند:

- `POST /mcp` به `http://127.0.0.1:8787`، همراه با `Host`، `Authorization`، `X-Forwarded-Proto` و `X-Forwarded-For`.
- WebSocket upgrade برای `/agent` به `http://127.0.0.1:8787`، همراه با `Upgrade`، `Connection`، `Host`، `Authorization`، `X-Desktop-Commander-Device-Id`، `X-Forwarded-Proto` و `X-Forwarded-For`.
- اگر Action API فعال است، مسیرهای `/action` و `/action/*` را به `http://127.0.0.1:8787` forward کنید و header مربوط به `Authorization` را حفظ کنید.

نمونهٔ فعلی Nginx مسیرهای MCP و Agent را مستند می‌کند. اگر Actions را فعال کرده‌اید و از locationهای جداگانه بر اساس path استفاده می‌کنید، یک route برای Action نیز به همان upstream اضافه کنید.

برای URLهای عمومی MCP و Action از HTTPS و برای URL مربوط به Agent از WSS استفاده کنید. این repository نمونه‌های proxy را ارائه می‌کند، اما certificate صادر نمی‌کند.

### 6. بررسی Server

از سیستمی که به hostname عمومی دسترسی دارد اجرا کنید:

```bash
curl -fsS https://relay.example.com/healthz
```

این endpoint باید پاسخ موفقی شامل فیلدهای وضعیت Server که توسط پروژه پیاده‌سازی شده‌اند برگرداند؛ پیش از اجرای Agent، تعداد deviceهای متصل باید `0` باشد.

### 7. Build و اجرای Relay Agent روی کامپیوتر کنترل‌شونده

دستورهای زیر را روی کامپیوتری اجرا کنید که DesktopCommanderMCP باید روی آن اجرا شود، نه روی Server:

```powershell
cd C:\path\to\DesktopCommanderRelay
npm ci
npm run build
$env:RELAY_WS_URL = "wss://relay.example.com/agent"
$env:AGENT_TOKEN = "<same-generated-agent-token-as-server>"
$env:DEVICE_ID = "home-pc"
npm run start:agent
```

`DEVICE_ID` به حروف کوچک و کاراکترهای مجاز identifier نرمال‌سازی می‌شود. هنگام انتخاب این device، مقدار `TARGET_DEVICE_ID` روی Server را روی همان مقدار نرمال‌شده تنظیم کنید.

Agent، DesktopCommanderMCP را با ترتیب زیر پیدا می‌کند:

1. `DESKTOP_COMMANDER_ENTRY`، در صورت تنظیم؛ این entry با Node executable فعلی اجرا می‌شود.
2. یک build هم‌سطح در مسیر `../DesktopCommanderMCP/dist/index.js` نسبت به دو directory هم‌سطح پروژه.
3. `DESKTOP_COMMANDER_COMMAND` که مقدار پیش‌فرض آن `desktop-commander` است، همراه با آرگومان‌های موجود در `DESKTOP_COMMANDER_ARGS_JSON` که مقدار پیش‌فرض آن `[]` است.

محیط child به‌صورت پیش‌فرض شامل safe environment subset مربوط به MCP SDK به‌اضافهٔ `DC_REMOTE_DEVICE=true` است. نام‌های اضافی فقط زمانی pass می‌شوند که در `DESKTOP_COMMANDER_ENV_ALLOWLIST` به‌صورت allowlist جداشده با comma مشخص شده باشند. credentialهای Relay را داخل این allowlist قرار ندهید مگر اینکه عمداً بخواهید آن‌ها را به child منتقل کنید.

اگر sibling build موجود نیست و فرمان نیز روی `PATH` قرار ندارد، قبل از اجرای Agent مسیر entry را صراحتاً مشخص کنید:

```powershell
$env:DESKTOP_COMMANDER_ENTRY = "C:\path\to\DesktopCommanderMCP\dist\index.js"
npm run start:agent
```

### 8. بررسی اتصال Agent

health check را دوباره اجرا کنید:

```bash
curl -fsS https://relay.example.com/healthz
```

اکنون مقدار `"devices"` باید `1` باشد. پس از اتصال یک MCP client، ابزار `relay_status` را فراخوانی کنید. اگر `TARGET_DEVICE_ID=home-pc` تنظیم شده باشد، باید `connected_devices: 1` و `selected_device: "home-pc"` گزارش شود.

اگر Action API فعال است، می‌توانید device انتخاب‌شده را از طریق endpoint وضعیت Action نیز بررسی کنید:

```bash
curl -fsS \
  -H "Authorization: Bearer $ACTION_API_KEY" \
  https://relay.example.com/action/status
```

### 9. اتصال Codex به‌عنوان MCP client

متغیر محیطی سمت Client را طوری تنظیم کنید که secret داخل تنظیمات Codex قرار نگیرد.

PowerShell:

```powershell
$env:DESKTOP_COMMANDER_RELAY_API_KEY = "<same-generated-mcp-api-key-as-server>"
```

POSIX shell:

```bash
export DESKTOP_COMMANDER_RELAY_API_KEY='<same-generated-mcp-api-key-as-server>'
```

پس از تنظیم این متغیر، اگر نسخهٔ Codex CLI نصب‌شدهٔ شما همان گزینهٔ bearer token مربوط به MCP را ارائه می‌کند، دستور زیر را اجرا کنید (با `codex mcp add --help` بررسی کنید):

```text
codex mcp add desktop-commander-relay --url https://relay.example.com/mcp --bearer-token-env-var DESKTOP_COMMANDER_RELAY_API_KEY
```

URL مربوط به MCP client برابر `https://relay.example.com/mcp` است؛ URL مربوط به Agent نیز به‌صورت جداگانه `wss://relay.example.com/agent` است. در پایان از MCP client متصل، `relay_status` یا `relay_list_devices` را فراخوانی کنید تا Agent انتخاب‌شده تأیید شود.

### 10. اتصال یک ChatGPT Custom GPT از طریق Actions

HTTP Action adapter برای clientهایی در نظر گرفته شده که به‌جای انتقال مستقیم MCP، می‌توانند عملیات REST/OpenAPI احراز هویت‌شده را فراخوانی کنند.

Action client را با Bearer authentication مبتنی بر `ACTION_API_KEY` و URL عمومی Server پیکربندی کنید، برای مثال:

```text
https://relay.example.com
```

Action API عملیات زیر را ارائه می‌کند:

| Method | Path | کاربرد |
| --- | --- | --- |
| `GET` | `/action/status` | deviceهای متصل، device انتخاب‌شده و هرگونه مشکل مربوط به انتخاب device را برمی‌گرداند. |
| `GET` | `/action/tools` | ابزارهای DesktopCommander قابل‌مشاهده برای Action را فهرست می‌کند. |
| `GET` | `/action/tools?name=<tool>` | تعریف کامل یک ابزار قابل‌مشاهده برای Action را برمی‌گرداند. |
| `POST` | `/action/tools/{name}/call` | یک ابزار مجاز DesktopCommander را روی Agent انتخاب‌شده فراخوانی می‌کند. |

فراخوانی ابزارها از ساختار request زیر استفاده می‌کند:

```json
{
  "arguments": {
    "path": "C:\\Users\\user\\Projects\\example.txt"
  }
}
```

Action API از همان منطق انتخاب device سمت Server که در مسیر MCP استفاده می‌شود بهره می‌برد. `/action/status` می‌تواند چند Agent متصل را گزارش کند، اما فراخوانی عادی ابزارهای Action همچنان به device انتخاب‌شده توسط `TARGET_DEVICE_ID` یا fallback تک-device خود Relay ارسال می‌شود.

## سیاست ابزارهای ChatGPT Action

رابط Action عمداً مجموعه‌ای از ابزارهای DesktopCommander را مخفی و رد می‌کند؛ ابزارهایی که ممکن است محدودیت‌های filesystem را دور بزنند یا policy محلی را تغییر دهند.

ابزارهای زیر در حال حاضر از طریق `/action` مسدود هستند:

```text
set_config_value
start_process
interact_with_process
read_process_output
force_terminate
kill_process
```

ابزارهای مسدودشده از `/action/tools` حذف می‌شوند. تلاش مستقیم برای فراخوانی یکی از آن‌ها، HTTP `403` همراه با خطایی برمی‌گرداند که مشخص می‌کند ابزار از طریق ChatGPT Actions مجاز نیست.

این فیلتر فقط روی رابط HTTP Action اعمال می‌شود. این کار ابزارها را از خود DesktopCommanderMCP حذف نمی‌کند و دسترسی احتمالی یک MCP client جداگانه و احراز هویت‌شده به آن ابزارها را تغییر نمی‌دهد.

سیاست فعلی مبتنی بر blocklist است. اگر به یک مرز امنیتی سخت‌گیرانه و file-only نیاز دارید، بهتر است آن را با یک allowlist صریح سمت Server جایگزین کنید تا ابزارهای جدیدی که در آینده به DesktopCommander upstream اضافه می‌شوند به‌صورت خودکار expose نشوند.

## محدودیت‌های filesystem در DesktopCommander

محدودیت‌های filesystem توسط DesktopCommanderMCP روی کامپیوتری که کنترل می‌شود اعمال می‌شوند، نه توسط path parser در Relay Server.

DesktopCommanderMCP از تنظیم `allowedDirectories` پشتیبانی می‌کند. برای مثال:

```json
{
  "allowedDirectories": [
    "C:\\Users\\user\\Projects",
    "C:\\Users\\user\\Documents\\AI-Work"
  ]
}
```

وقتی این تنظیم فعال باشد، ابزارهای filesystem در DesktopCommander مانند `read_file`، `write_file`، `list_directory`، `move_file`، `get_file_info` و `edit_block` مسیرهای خارج از این directoryها را رد می‌کنند.

نکات امنیتی مهم:

- بسته به semantics تنظیمات DesktopCommanderMCP، خالی بودن `allowedDirectories` ممکن است به معنای دسترسی نامحدود به filesystem باشد. پیش از در معرض قرار دادن یک remote client، تنظیم محلی را بررسی کنید.
- Action API ابزار `set_config_value` را مسدود می‌کند، بنابراین یک ChatGPT Action client نمی‌تواند از طریق Action adapter فعلی مقدار `allowedDirectories` را حذف یا گسترش دهد.
- Action API همچنین ابزارهای terminal/process ذکرشده در بالا را مسدود می‌کند تا نتوان از طریق Actions به‌سادگی محدودیت path در filesystem را دور زد.
- این محدودیت‌ها به‌صورت خودکار یک client مستقیم/محلی دیگر برای DesktopCommander که دسترسی گسترده‌تری به ابزارها دارد را محدود نمی‌کنند.
- permissionهای سیستم‌عامل یک مرز نهایی قوی‌تر هستند. برای deploymentهایی که به اطمینان امنیتی بیشتری نیاز دارند، Agent/DesktopCommander را تحت یک حساب کاربری اختصاصی سیستم‌عامل اجرا کنید که فقط به directoryهای موردنیاز دسترسی داشته باشد.

## نیازمندی‌ها و فرمان‌ها

- Node.js نسخه `>=20.0.0` و npm برای فرمان‌های native مربوط به Server/Agent و همچنین build کردن Agent لازم هستند. Docker image از Node 22 Alpine استفاده می‌کند.
- پکیج‌های MCP SDK نصب‌شده در lockfile نسخه `2.0.0` هستند. Server، handler مربوط به Streamable HTTP در SDK را با legacy stateless mode پیکربندی می‌کند.
- `npm ci` dependencyها را از lockfile نصب می‌کند.
- `npm run build` کد TypeScript را داخل `dist/` کامپایل می‌کند.
- `npm run start:server` و `npm run start:agent` پردازش‌های کامپایل‌شده را اجرا می‌کنند.
- `npm run dev:server` و `npm run dev:agent` entrypointهای TypeScript را برای development از طریق `tsx` اجرا می‌کنند.
- `npm run typecheck` بررسی TypeScript بدون تولید خروجی انجام می‌دهد.
- `npm test` تست‌های repository را اجرا می‌کند. `npm run check` عملیات build، typecheck و test را اجرا می‌کند؛ این یک فرمان verification برای developer است و پیش‌نیاز نصب محسوب نمی‌شود.
- `npm run secrets` یک `MCP_API_KEY` تصادفی و یک `AGENT_TOKEN` تصادفی چاپ می‌کند، بدون اینکه آن‌ها را داخل فایل بنویسد. هنگام فعال کردن Action API، مقدار `ACTION_API_KEY` را جداگانه تولید کنید.

## پیکربندی

Server و Agent باید از environment fileهای جداگانه استفاده کنند. credential واقعی را هرگز commit نکنید.

### متغیرهای Server

| متغیر | مقدار لازم/پیش‌فرض | توضیح |
| --- | --- | --- |
| `HOST` | پیش‌فرض `127.0.0.1`؛ Compose آن را داخل container روی `0.0.0.0` override می‌کند | آدرس bind مربوط به Server. bind عمومی به `MCP_ALLOWED_HOSTS` نیاز دارد. |
| `PORT` | `8787` | port مربوط به HTTP listener. |
| `MCP_PATH` | `/mcp` | مسیر HTTP مربوط به MCP. |
| `ACTION_PATH` | `/action` | مسیر پایه برای HTTP Action API احراز هویت‌شده. |
| `AGENT_WS_PATH` | `/agent` | مسیر WebSocket مربوط به Agent. |
| `MCP_API_KEY` | الزامی، مگر اینکه insecure loopback mode فعال باشد | Bearer token برای درخواست‌های HTTP مربوط به MCP. |
| `ACTION_API_KEY` | هنگام expose کردن عمومی Action API الزامی است | Bearer token مستقل برای `/action/*`. از `MCP_API_KEY` یا `AGENT_TOKEN` مجدداً استفاده نکنید. |
| `AGENT_TOKEN` | الزامی، مگر اینکه insecure loopback mode فعال باشد | Bearer token مستقل برای اتصال WebSocket مربوط به Agent. |
| `TARGET_DEVICE_ID` | اختیاری | یک device متصل را انتخاب می‌کند. بدون target، در صورت وجود فقط یک device متصل، همان device به‌صورت خودکار انتخاب می‌شود. |
| `MCP_ALLOWED_HOSTS` | در صورت unset بودن: `localhost,127.0.0.1,[::1]`؛ برای bind عمومی الزامی است | hostnameهای مجاز جداشده با comma، بدون scheme یا port. |
| `MCP_ALLOWED_ORIGINS` | پیش‌فرض برابر allowed hostnameها | origin یا hostnameهای اختیاری جداشده با comma. تطبیق فقط بر اساس hostname انجام می‌شود؛ scheme و port نادیده گرفته می‌شوند. |
| `ALLOW_INSECURE_LOCAL` | `false` | bypass مخصوص development برای credentialها روی bind غیرعمومی. استفاده از آن روی `0.0.0.0` و `::` رد می‌شود. |
| `TOOL_CALL_TIMEOUT_MS` | `300000` | timeout سمت Server برای tool call. |
| `MAX_PENDING_CALLS_PER_DEVICE` | `64` | حداکثر تعداد callهای pending برای هر device انتخاب‌شده. |
| `WS_MAX_PAYLOAD_BYTES` | `33554432` | حداکثر payload مربوط به WebSocket سمت Server. |
| `HTTP_BODY_LIMIT` | `32mb` | محدودیت body در Express JSON. |
| `AGENT_HELLO_TIMEOUT_MS` | `10000` | زمان مجاز برای hello message مربوط به Agent. |
| `WS_HEARTBEAT_MS` | `20000` | فاصله زمانی heartbeat مربوط به WebSocket. |

### متغیرهای Agent

| متغیر | مقدار لازم/پیش‌فرض | توضیح |
| --- | --- | --- |
| `RELAY_WS_URL` | الزامی | URL مربوط به WebSocket، معمولاً `wss://relay.example.com/agent`. |
| `AGENT_TOKEN` | الزامی | باید با `AGENT_TOKEN` سمت Server برابر باشد، نه `MCP_API_KEY` یا `ACTION_API_KEY`. |
| `DEVICE_ID` | پیش‌فرض hostname | شناسهٔ device ارسال‌شده به Server. از همان مقدار نرمال‌شده در `TARGET_DEVICE_ID` استفاده کنید. |
| `DEVICE_NAME` | پیش‌فرض hostname | نام نمایشی گزارش‌شده توسط Agent. |
| `DESKTOP_COMMANDER_ENTRY` | اختیاری | مسیر صریح به JavaScript entrypoint مربوط به DesktopCommanderMCP. بالاترین اولویت resolution را دارد. |
| `DESKTOP_COMMANDER_COMMAND` | `desktop-commander` | executable یا command جایگزین وقتی explicit/sibling entry پیدا نشود. |
| `DESKTOP_COMMANDER_ARGS_JSON` | `[]` | آرایه JSON از آرگومان‌های string برای fallback command. |
| `DESKTOP_COMMANDER_ENV_ALLOWLIST` | خالی | نام environment variableهای اضافی جداشده با comma که باید به child منتقل شوند. |
| `AGENT_MAX_CONCURRENCY` | `4` | حداکثر تعداد tool callهای محلی که هم‌زمان اجرا می‌شوند. |
| `AGENT_MAX_QUEUE` | `100` | حداکثر تعداد callهای queued وقتی همه concurrency slotها مشغول هستند. |
| `AGENT_RECONNECT_MIN_MS` / `AGENT_RECONNECT_MAX_MS` | `1000` / `30000` | محدوده‌های backoff برای reconnect. |
| `AGENT_RESULT_CACHE_SIZE` | `100` | تعداد نتیجهٔ کامل‌شدهٔ call که برای duplicate call IDها نگه‌داری می‌شود. |
| `AGENT_TOOL_REFRESH_MS` | `60000`؛ مقدار `0` refresh را غیرفعال می‌کند | فاصله زمانی refresh شدن لیست toolهای محلی توسط Agent. |
| `AGENT_WS_MAX_PAYLOAD_BYTES` | `33554432` | حداکثر payload مربوط به WebSocket سمت Agent. |

## انتخاب device

Server می‌تواند چند Agent متصل را track کند، اما نام معمول ابزارهای DesktopCommanderMCP بر اساس device namespace نمی‌شود.

- اگر دقیقاً یک Agent متصل باشد و `TARGET_DEVICE_ID` تنظیم نشده باشد، همان Agent انتخاب می‌شود.
- اگر چند Agent متصل باشند و target تنظیم نشده باشد، ابزارهای عادی DesktopCommanderMCP تا زمان تنظیم `TARGET_DEVICE_ID` در دسترس نخواهند بود.
- اگر `TARGET_DEVICE_ID` آفلاین باشد، ابزارهای معمول DesktopCommanderMCP تا زمان reconnect آن در دسترس نخواهند بود.
- `relay_status` و `relay_list_devices` همیشه از طریق MCP relay برای وضعیت و کشف device در دسترس هستند.
- `/action/status`، deviceهای متصل و device انتخاب‌شده را به Action client گزارش می‌کند.
- endpoint فعلی Action برای فراخوانی tool، پارامتر `device_id` را در هر request نمی‌پذیرد؛ از device انتخاب‌شده توسط Server استفاده می‌کند.

## امنیت

برای deployment عمومی از HTTPS/WSS از طریق reverse proxy استفاده کنید. listener خام Node را مستقیماً در معرض Internet قرار ندهید.

مقادیر `MCP_API_KEY`، `ACTION_API_KEY` و `AGENT_TOKEN` را تصادفی، جدا از یکدیگر و خارج از source control نگه دارید. این مقادیر از interfaceهای متفاوت محافظت می‌کنند و نباید دوباره استفاده شوند.

هر کسی که `MCP_API_KEY` را در اختیار داشته باشد می‌تواند از طریق interface مربوط به MCP ابزارهای exposeشده توسط Agent متصل و انتخاب‌شده را فراخوانی کند؛ البته همچنان محدودیت‌های خود DesktopCommanderMCP و رفتار Relay در مسیر MCP اعمال می‌شوند.

هر کسی که `ACTION_API_KEY` را داشته باشد می‌تواند از ابزارهایی که از طریق `/action/tools` expose شده‌اند استفاده کند. Action adapter فعلی فیلتر ابزار سمت Server خودش را اعمال می‌کند و ابزارهای مسدودشدهٔ مستندشده در بالا را رد می‌کند. این فیلتر مخصوص Action، خود DesktopCommanderMCP را تغییر نمی‌دهد.

حتی با وجود مسدود بودن ابزارهای process، Action API را همچنان یک interface قدرتمند برای remote control در نظر بگیرید. ابزارهای باقی‌مانده همچنان ممکن است داخل directoryهای مجاز محلی فایل‌ها را بخوانند، ایجاد کنند، تغییر دهند، جابه‌جا کنند، جستجو کنند یا اطلاعات آن‌ها را بررسی کنند. بعضی ابزارهای DesktopCommander ممکن است رفتارهای غیر-filesystem نیز داشته باشند؛ پیش از دادن Action key به یک client، لیست ابزارهای قابل‌مشاهده را بررسی کنید.

`allowedDirectories` یک محدودیت سمت DesktopCommanderMCP است. برای isolation قوی‌تر، آن را با permissionهای filesystem سیستم‌عامل و یک service account اختصاصی روی کامپیوتر کنترل‌شونده ترکیب کنید.

Host validation و validation مربوط به Agent WebSocket از `MCP_ALLOWED_HOSTS` استفاده می‌کنند. Origin validation زمانی اعمال می‌شود که request دارای header مربوط به `Origin` باشد. هر دو بررسی hostname را مقایسه می‌کنند؛ scheme و port تعریف‌شده برای origin مقایسه نمی‌شوند. وقتی اتصال‌های browser-originated مورد انتظار هستند، `MCP_ALLOWED_ORIGINS` را صراحتاً تنظیم کنید.

Relay محدودیت‌هایی برای payloadهای HTTP/WebSocket، کارهای pending و queued و مدت‌زمان tool call اعمال می‌کند. همچنین از WebSocket heartbeat استفاده می‌کند و در حالت عادی از log کردن argumentها و resultهای ابزار خودداری می‌کند. `ALLOW_INSECURE_LOCAL=true` فقط برای development روی loopback در نظر گرفته شده است.

برای یک integration شخصی و خصوصی با ChatGPT، Custom GPT را private نگه دارید و Action credentialهای آن را به اشتراک نگذارید.

## رفتار failure و retry

هر tool call که forward می‌شود یک Relay call ID دارد. Agent یک result cache محدود نگه می‌دارد و یک ID تکراری را دو بار اجرا نمی‌کند؛ duplicate در حال اجرا نیز در صورت موجود بودن، همان نتیجه موجود را دریافت می‌کند.

callهای queued برای یک WebSocket قطع‌شده دور ریخته می‌شوند. callای که ممکن است قبلاً در حال اجرا باشد پس از disconnect به‌صورت خودکار replay نمی‌شود، زیرا replay یک command دارای side effect ممکن است باعث اجرای دوباره آن شود. remote client یک failure دریافت می‌کند و باید خودش تصمیم بگیرد که retry امن است یا نه. tool callها همچنین در صورت رسیدن به timeout سمت Server یا pending-call limit شکست می‌خورند.

Agent با bounded backoff دوباره متصل می‌شود و به‌صورت دوره‌ای لیست toolهای محلی را refresh می‌کند. بنابراین یک DesktopCommanderMCP جدید یا restartشده می‌تواند پس از refresh بعدی ابزارهای advertiseشده توسط Agent را تغییر دهد. ابزارهای قابل‌مشاهده برای Action از همان tool list مشتق می‌شوند و سپس policy مربوط به ابزارهای Action روی آن‌ها اعمال می‌شود.

## روش‌های جایگزین استقرار

### Docker Compose

`Dockerfile` یک production server image با Node 22 Alpine می‌سازد و `dist/server/index.js` را با کاربر non-root به نام `node` اجرا می‌کند. `docker-compose.yml` فایل `.env` را load می‌کند، bind کانتینر را روی `0.0.0.0` قرار می‌دهد و `127.0.0.1:8787:8787` را publish می‌کند.

### systemd

unitهای نمونهٔ [`deploy/desktop-commander-relay-server.service`](deploy/desktop-commander-relay-server.service) و [`deploy/desktop-commander-relay-agent.service`](deploy/desktop-commander-relay-agent.service) از مسیرهای زیر استفاده می‌کنند:

- Server: `/opt/DesktopCommanderRelay`، `/opt/DesktopCommanderRelay/.env` و `/opt/DesktopCommanderRelay/dist/server/index.js`.
- Agent: `%h/DesktopCommanderRelay`، همراه با environment file در `%h/.config/desktop-commander-relay/agent.env` و `%h/DesktopCommanderRelay/dist/agent/index.js`.

unit مناسب را داخل `/etc/systemd/system/` کپی کنید، مسیرها و permissionهای service account را تنظیم کنید، سپس systemd را reload و سرویس را enable کنید:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now desktop-commander-relay-server.service
sudo systemctl status desktop-commander-relay-server.service
```

برای Agent نیز از فرمان‌های مشابه مربوط به `desktop-commander-relay-agent.service` استفاده کنید. unit fileها Node.js را نصب نمی‌کنند، پروژه را build نمی‌کنند و environment file ایجاد نمی‌کنند.

### Nginx

[`deploy/nginx.conf.example`](deploy/nginx.conf.example) شامل routeهای proxy مربوط به MCP و Agent، headerهای forwardشده، تنظیمات buffering، محدودیت body size و timeoutهای مورد استفاده در نمونه است. TLS termination باید داخل HTTPS server block انجام شود، نه داخل Node process.

اگر Action API فعال است، مسیرهای `/action` و `/action/*` را به همان upstream یعنی `127.0.0.1:8787` proxy کنید و header مربوط به Bearer `Authorization` را حفظ کنید.

## توسعه

برای development محلی، از environment valueهای جداگانه برای Server و Agent استفاده کنید. entrypointهای development موجود عبارت‌اند از:

```bash
npm run dev:server
npm run dev:agent
```

برای اجرای verification کامل repository از دستور زیر استفاده کنید:

```bash
npm run check
```

این command عملیات build، typecheck و testها را اجرا می‌کند. اجرای آن برای Quick Start در محیط production الزامی نیست.
