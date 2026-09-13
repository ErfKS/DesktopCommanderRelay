<!-- Persian RTL version. Persian prose uses Unicode RTL marks; code blocks, paths, commands, and identifiers remain LTR. -->


# ‏امنیت

‏DesktopCommanderRelay یک نمونهٔ محلی از DesktopCommanderMCP را از طریق دو رابط احراز هویت‌شده در اختیار کلاینت‌های راه‌دور قرار می‌دهد: endpoint مربوط به MCP و، به‌صورت اختیاری، HTTP Action API. تمام credentialهای Relay را secretهای باارزش در نظر بگیرید.

## ‏الزامات محیط Production

- ‏از HTTPS/WSS استفاده کنید. listener خام HTTP مربوط به Node را مستقیماً در معرض اینترنت قرار ندهید.
- ‏مقادیر `MCP_API_KEY`، `ACTION_API_KEY` و `AGENT_TOKEN` را متفاوت، تصادفی و خارج از source control نگه دارید. برای هرکدام حداقل 256 بیت entropy توصیه می‌شود.
- ‏فایل `.env` و environment fileهای Agent را خارج از source control نگه دارید و دسترسی خواندن آن‌ها را فقط به service account بدهید.
- ‏اگر Vision Bridge فعال است، `OPENAI_API_KEY` را فقط روی Relay Server نگه دارید و هرگز آن را به Relay Agent یا Action client منتقل نکنید.
- ‏وقتی reverse proxy روی همان host اجرا می‌شود، Node را روی loopback bind کنید.
- ‏تنظیمات امنیتی محلی Desktop Commander از جمله `allowedDirectories`، blocked commands و تنظیمات مرتبط را محافظه‌کارانه پیکربندی کنید.
- ‏در deployment عمومی، `ALLOW_INSECURE_LOCAL` را فعال نکنید.
- ‏برای Relay ترجیحاً یک DNS اختصاصی و firewall ruleهای مناسب در نظر بگیرید.
- ‏پیش از bind کردن عمومی Node، مقدار `MCP_ALLOWED_HOSTS` را دقیقاً روی hostnameهای عمومی Relay تنظیم کنید. این کار مسیرهای HTTP و WebSocket را در برابر خطاهای Host-header و DNS rebinding محافظت می‌کند.
- ‏وقتی اتصال‌های browser-originated برای MCP یا Agent مورد انتظار هستند، `MCP_ALLOWED_ORIGINS` را تنظیم کنید. اگر header مربوط به `Origin` با allowlist پیکربندی‌شده مطابقت نداشته باشد، request رد می‌شود.
- ‏Custom GPTهای شخصی ChatGPT را Private نگه دارید و Action credentialهای آن‌ها را به اشتراک نگذارید.

## ‏Credentialها و مرزهای اعتماد

‏DesktopCommanderRelay برای interfaceهای مختلف از credentialهای جداگانه استفاده می‌کند:

- ‏`MCP_API_KEY` درخواست‌های راه‌دور MCP به `/mcp` را احراز هویت می‌کند.
- ‏`ACTION_API_KEY` درخواست‌های HTTP Action به `/action/*` را احراز هویت می‌کند.
- ‏`AGENT_TOKEN` اتصال Relay Agentها از طریق WebSocket را احراز هویت می‌کند.
- ‏`OPENAI_API_KEY`، در صورت فعال بودن Vision Bridge، درخواست‌های outbound مربوط به Vision از Relay Server به OpenAI را احراز هویت می‌کند و credential مربوط به Relay client نیست.

‏از یک credential برای چند interface استفاده نکنید.

### ‏رابط MCP

‏مسیر MCP یک رابط remote-control گسترده است. Server، MCP client را احراز هویت می‌کند، یک device احراز هویت‌شده را انتخاب می‌کند و فراخوانی ابزارهای DesktopCommander را به Agent انتخاب‌شده منتقل می‌کند.

‏برای ابزارهای معمول DesktopCommander، MCP Relay آرگومان‌های ابزار را به یک مدل authorization مجزای per-tool تبدیل یا reinterpret نمی‌کند. کلاینتی که `MCP_API_KEY` را در اختیار داشته باشد می‌تواند ابزارهای exposeشده توسط Agent انتخاب‌شده را فراخوانی کند؛ البته محدودیت‌های خود DesktopCommanderMCP و رفتار Relay در مسیر MCP همچنان اعمال می‌شوند.

‏اگر MCP clientهای مختلف باید capabilityهای متفاوتی دریافت کنند، از deploymentهای جداگانهٔ Relay یا یک authorization layer اختصاصی استفاده کنید.

### ‏رابط Action

‏رابط HTTP Action پیش از forward کردن فراخوانی‌ها به DesktopCommanderMCP، یک policy اضافی در سمت Server روی ابزارها اعمال می‌کند.

‏ابزارهای زیر همیشه از `/action/tools` مخفی هستند و در صورت فراخوانی مستقیم از طریق `/action` رد می‌شوند:

```text
set_config_value
kill_process
```

‏ابزارهای process/session یعنی `start_process`، `interact_with_process`، `read_process_output` و `force_terminate` به‌صورت شرطی قابل استفاده‌اند. این ابزارها به `device_id` صریح موجود در `ACTION_SANDBOX_DEVICE_IDS` نیاز دارند. روی deviceهای دیگر یا بدون routing صریح، این ابزارها مخفی هستند و فراخوانی مستقیم آن‌ها HTTP `403` برمی‌گرداند.

‏`ACTION_SANDBOX_DEVICE_IDS` فقط یک authorization list است. نام آن legacy است: قرار دادن یک host در این لیست، آن را sandbox نمی‌کند و isolation ایجاد نمی‌کند؛ بلکه اجرای process از طریق Action را با permissionهای حساب Relay Agent/DesktopCommander روی همان device مجاز می‌کند.

‏این filtering فقط روی رابط HTTP Action اعمال می‌شود. ابزارها را از DesktopCommanderMCP حذف نمی‌کند و capabilityهای یک MCP client جداگانه و احراز هویت‌شده را کاهش نمی‌دهد.

‏بخش باقی‌ماندهٔ policy Action یک allowlist بستهٔ per-tool نیست. برای deploymentهای سخت‌گیرانه‌تر، استفاده از یک allowlist صریح را ترجیح دهید و بعد از upgrade کردن DesktopCommanderMCP مسیر `/action/tools` را بررسی کنید.

## ‏محدودیت‌های Filesystem

‏محدودیت‌های filesystem از طریق تنظیماتی مانند `allowedDirectories` توسط DesktopCommanderMCP روی کامپیوتر کنترل‌شونده اعمال می‌شوند.

‏وقتی `allowedDirectories` پیکربندی شده باشد، ابزارهای filesystem مربوط به DesktopCommander باید pathهای خارج از directoryهای مجاز را رد کنند.

‏نکات مهم:

- ‏قبل از expose کردن یک remote client، semantics مربوط به خالی بودن `allowedDirectories` را بررسی کنید؛ بسته به تنظیمات DesktopCommanderMCP، لیست خالی ممکن است به معنای دسترسی نامحدود به filesystem باشد.
- ‏Action API فعلی ابزار `set_config_value` را مسدود می‌کند، بنابراین Action client نمی‌تواند از طریق Action adapter مقدار `allowedDirectories` را حذف یا گسترش دهد.
- ‏ابزارهای process/session فقط برای `device_id` صریح موجود در `ACTION_SANDBOX_DEVICE_IDS` مجاز هستند. هر device موجود در این لیست را process-execution-enabled در نظر بگیرید.
- ‏این محافظت‌ها به‌صورت خودکار یک client محلی یا MCP client جداگانه با دسترسی گسترده‌تر به ابزارهای DesktopCommander را محدود نمی‌کنند.
- ‏permissionهای سیستم‌عامل یک مرز نهایی قوی‌تر هستند. برای deploymentهای حساس، Relay Agent/DesktopCommander را با یک حساب کاربری اختصاصی سیستم‌عامل اجرا کنید که فقط به directoryهای موردنیاز دسترسی داشته باشد.

## ‏Vision Bridge

‏مسیر `POST /action/images/analyze` با `ACTION_API_KEY` احراز هویت می‌شود و علاوه بر آن به یک `device_id` صریح موجود در `ACTION_VISION_DEVICE_IDS` نیاز دارد. این endpoint به `TARGET_DEVICE_ID` fallback نمی‌کند.

‏Vision Bridge محدودیت‌های ورودی اضافه‌ای اعمال می‌کند:

- ‏path تصویر باید یک مسیر absolute محلی لینوکس در `/projects/` یا `/workspace/` باشد.
- ‏URL، Windows path، parent-directory traversal، extensionهای پشتیبانی‌نشده و MIME typeهای تصویری پشتیبانی‌نشده رد می‌شوند.
- ‏ابزار `read_file` در Desktop Commander با URL mode صراحتاً غیرفعال فراخوانی می‌شود.
- ‏اندازهٔ decoded image پیش از ارسال upstream محدود می‌شود.
- ‏متن یا instructionهای قابل‌مشاهده داخل تصویر به‌عنوان دادهٔ غیرقابل‌اعتماد تصویر در نظر گرفته می‌شوند، نه دستورهایی که bridge باید اجرا کند.

‏محتوای تصویر و prompt مربوط به Vision با `OPENAI_API_KEY` سمت Server به OpenAI API ارسال می‌شوند. برای داده‌هایی که باید کاملاً local باقی بمانند Vision Bridge را فعال نکنید. `OPENAI_API_KEY` را فقط روی Relay Server نگه دارید و هرگز آن را داخل Agent environment، Custom GPT schema، client configuration یا source control قرار ندهید.

‏mountهای filesystem، محدودیت‌های DesktopCommander و permissionهای سیستم‌عامل همچنان اعمال می‌شوند. Vision Bridge دسترسی به فایلی که Agent انتخاب‌شده نمی‌تواند بخواند ایجاد نمی‌کند.

## ‏انتخاب Device

‏Server می‌تواند چند Agent متصل را track کند.

‏فراخوانی‌های عادی MCP و فراخوانی‌های Action بدون `device_id` صریح از device انتخاب‌شده توسط `TARGET_DEVICE_ID` یا fallback تک-device Relay استفاده می‌کنند. برای فراخوانی‌های عادی Action، `device_id` صریح بر این انتخاب اولویت دارد. ابزارهای process/session در Action و تحلیل Vision علاوه بر این، به allowlist مربوط به device خود نیاز دارند.

‏`/action/status`، `relay_status` و `relay_list_devices` ممکن است metadata مربوط به deviceهای متصل را در اختیار کلاینت‌های احراز هویت‌شده قرار دهند. نام یا ID مربوط به device را secret در نظر نگیرید، اما اطلاعات حساس را داخل آن‌ها قرار ندهید.

## ‏Logها

‏Relay عمداً در حالت عادی از log کردن آرگومان‌ها و resultهای ابزارها خودداری می‌کند، زیرا ممکن است شامل محتوای فایل‌ها، credentialها، command output یا سایر اطلاعات حساس باشند.

‏از اضافه کردن debug logging برای موارد زیر خودداری کنید:

- ‏Bearer tokenها یا environment secretها
- ‏آرگومان‌های ابزار یا result کامل ابزار
- ‏محتوای فایل‌ها یا payloadهای تصویری
- ‏promptهای Vision یا پاسخ کامل Vision در صورتی که شامل اطلاعات حساس باشند
- ‏command output شامل credential یا اطلاعات خصوصی

## ‏راهنمای عملیاتی

- ‏هر credential مربوط به Relay که احتمال می‌دهید افشا شده است را rotate کنید.
- ‏پس از تغییرات امنیتی در source، Relay را restart یا rebuild کنید تا deployment در حال اجرا با کد reviewشده یکسان باشد.
- ‏بعد از upgrade کردن DesktopCommanderMCP، مسیر `/action/tools` را بررسی کنید، زیرا tool list مربوط به upstream ممکن است تغییر کند.
- ‏DesktopCommanderMCP، Node.js، سیستم‌عامل و reverse proxy را به‌روز و patched نگه دارید.
- ‏از configuration به‌صورت امن backup بگیرید، اما secretهای production را هرگز داخل Git commit نکنید.

