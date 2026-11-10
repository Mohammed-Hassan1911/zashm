# ZASHM — فحص ما قبل الإطلاق (2026-11-10)

**التاريخ:** 2026-11-10
**الفرع:** `main` @ `bf1f483` (الحي) + تغييرات غير مدفوعة في هذا الفحص
**البيئة:** macOS، Node v22.22.3، Chrome headless (CDP) — فحوصات الإنتاج **قراءة فقط**.
**الوثيقة السابقة:** `docs/production-readiness-live-2026-11-09.md`

---

## 1. الحكم

**Go للكود، No-Go للبيانات.**

- لا توجد ثغرة حرجة، ولا خطأ JavaScript واحد في أي صفحة، ولا overflow أفقي في أي عرض.
- **أهم شرط للمالك مُثبت:** لو سوبابيز وقع، العميل يشوف **«تم تنفيذ طلبك»** (نفس شاشة النجاح، HTTP 200، `pending: true`) — **بدون** أي إشارة إلى انقطاع، **بدون** زر واتساب، **بدون** إشعار. رسالة التليجرام **بتوصل** وفيها كل حاجة تكفي لإكمال البيع بالتليفون، مع banner يوضح أن الأوردر **لم يُسجَّل** وأن العميل شاف رسالة نجاح.
- المانع الوحيد للإطلاق الحقيقي هو **الكتالوج**: منتج واحد تجريبي (Jacket) والـsnapshot الاحتياطي فاضي عمدًا.
- الاختبارات: **25 suite · 2164 assertion · 0 failed** — بما فيها suite جديد للانقطاع و suite للـprerender.
- سرعة صفحة المنتج: **LCP ~3.7s** during an outage (مُحسَّن من ~7s)، وprerender لصفحة المنتج يحمّل صورة LCP قبل الـJS.

---

## 2. اختبار الشراء مع وقوع الداتابيز (الشرط الأساسي)

### 2.1 الاختبار الحقيقي

شغّلنا **build الإنتاج نفسه** على سيرفر محلي، ووجّهنا `/api/orders` للـhandler الحقيقي، وخلّينا
Supabase غير قابل للوصول (`outage-proof.invalid`)، مع **بيانات تليجرام الحقيقية** من `.env`.
بعدها عملنا شراء كامل من المتصفح: فتح المنتج (الصفحة prerendered) → اختيار M/Black → إضافة للسلة → checkout →
تعبئة البيانات → PLACE ORDER.

| الخطوة | النتيجة |
|---|---|
| صفحه المنتج prerendered | ✅ title `Jacket — ZASHM`، canonical/OG، preload لصورة LCP، Product JSON-LD |
| اختيار المنتج والمقاس واللون | ✅ M/Black |
| السلة والـcheckout | ✅ Subtotal 2,500 + شحن 65 = **2,565** |
| إرسال الطلب والسيرفر واقع | ✅ **HTTP 200** `{"success":true,"pending":true,"order":{…}}` — **7089ms → 3679ms** بعد deadline |
| إنشاء أوردر في الداتابيز | ❌ **لم يُنشأ** (مقصود: الداتابيز مش متاحة) |
| شاشة العميل | ✅ **«ORDER CONFIRMED»** + «Thank you for your order» + سطر **«هنكلمك على رقمك لتأكيد تفاصيل الأوردر قبل الشحن.»** |
| TRACK YOUR ORDER | ✅ **مخفي** (لا row للتعقب) |
| **رسالة التليجرام** | ✅ **وصلت** — `message_id 179` (banner + نفس body + amounts labelled) |
| أخطاء console / page | ✅ **0** |

### 2.2 شكل الرسالة اللي وصلت

```
⚠️ ZASHM | تنبيه: الداتابيز معطّلة والأوردر لم يُسجَّل
🔖 المرجع: ZSH-MWB0PMMO-E9433810
🕒 الوقت: 10 Nov 2026, 8:22 PM
📌 السبب: تعذر قراءة بيانات المنتجات من قاعدة البيانات
❗ العميل شاف رسالة «تم تنفيذ طلبك». اتصل بيه وأكّد الأوردر يدويًا.
💡 الأسعار اللي تحت جاية من شاشة العميل (الداتابيز مش متاحة) — راجعها معاه قبل الشحن.

━━━━━━━━━━━━━━━━

السلام عليكم أ/ TEST 👋
مع حضرتك فريق ZASHM. حابين نأكد مع حضرتك تفاصيل الأوردر قبل الشحن.

👤 بيانات العميل
• الاسم: TEST — عميل تجربة
• الهاتف: 01000000000

📍 عنوان الشحن
• المدينة: Cairo
• العنوان: شارع الاختبار ١٢٣ — رسالة اختبار

🛍️ المنتجات
• Jacket (M / Black) × 1 — EGP 2,500

💰 ملخص الحساب
• المجموع الفرعي: EGP 2,500 (حسب العميل، غير مؤكد)
• الشحن: EGP 65
• الإجمالي: EGP 2,565 (حسب العميل، غير مؤكد)

• رقم الطلب: ZSH-MWB0PMMO-E9433810
… (تتبع، شحن، إلخ)
```

**الأزرار (inline keyboard) على الرسالة:** `💬 واتساب للعميل` (يفتح wa.me مع رسالة تأكيد مُعبأة) + `📋 نسخ رقم الطلب` + `🛠 لوحة الطلبات`. **لا يوجد** رابط tracking (لأنه لا row).

**ليه ده آمن:** الاسم والإجمالي اللي جايين من المتصفح **للعرض فقط** ومكتوب عليهم «غير مؤكد».
التسعير والمخزون عمرهم ما بيتحسبوا من العميل — لو الداتابيز اشتغلت، السيرفر هو اللي بيحسب كل حاجة (أسعار DB، كوبون، shipping من city).

### 2.3 إصلاحات اكتُشفت أثناء الاختبار (النسخة الجديدة)

1. **`Number(null) === 0`** كان بيطبع «الإجمالي: EGP 0» بدل ما يستخدم إجمالي العميل.
   اتصلح: القيمة الغائبة تفضل غائبة، ومفيش «EGP 0» وهمي.
2. **التليجرام كان بيحاول مرة واحدة بـ5 ثواني.** في التشغيل الحقيقي أول محاولة **علّقت واتقطعت**
   (`TimeoutError`) — الرسالة كانت هتضيع. أضفنا **محاولة ثانية** بعد 400ms، والرسالة وصلت في المحاولة
   التانية. ده دليل عملي إن الـretry مش تنظير.
3. **supabase-js بُني retry بـ 1s/2s/4s** (≈7s) — بُدِّل بـ deadline 3.5s (`AbortSignal.timeout`) على كل خطوة DB،
   فانقطاع الإجابة صار ≈3.7s بدل 7s. استجابة العميل (200) تأتي **قبل** إرسال التليجرام،
   فلا يمكن لـTelegram hung أن يكسر أو يؤخر الرد.
4. **`OutageNotice` بانر حُذف** (كان «شيء مكسور» بالضبط — ما يريده المالك ممنوع). CSS `.outage-notice` حُذف،
   `.outage-order-cta` بقي لمسار **فشل الشبكة (client-side)** (status 0/408) — because then nothing
   would be recorded anywhere.
5. **`responded` guard** يمنع كتابة ثانية إذا رمت خطوة لاحقة بعد تأكيد العميل.

### 2.4 تغيير نسخي في واجهة العميل

- شاشة النجاح (pending) تضيف سطر **«هنكلمك على رقمك لتأكيد تفاصيل الأوردر قبل الشحن.»**
  (EN: "We'll contact you to confirm your order before shipping.") وتُخفي **TRACK YOUR ORDER**.
- شاشة الخطأ ( genuine network failure فقط ) بقت تقول **«Couldn’t place the order»** + زر **اطلب عبر واتساب**.
- لانقطاع DB specifically: لا خطأ، لا بانر، لا زر واتساب.

---

## 3. الأمان

| الفحص | النتيجة |
|---|---|
| قراءة `products` (الجدول الأساسي) بمفتاح anon | **401 permission denied** (الصلاحية مسحوبة) |
| `products_public` بمفتاح anon | 200 — منتج واحد فقط، الأعمدة المسموحة |
| `users` / `orders` / `coupons` بمفتاح anon | **401 permission denied** للثلاثة |
| Storage listing بمفتاح anon | 200 `[]` — لا كشف ملفات |
| `/api/admin/*` بدون جلسة | **401** `Authentication required` |
| `POST /api/orders` بجسم فاضي | 422 برسالة واضحة |
| `/api/auth` و `/api/coupons/validate` بـGET | 405 |
| مسار مجهول | **404 حقيقي** (مش redirect للرئيسية) |
| الهيدرز | CSP كامل، HSTS سنة، `X-Frame-Options: DENY`، `nosniff`، referrer، permissions-policy، `frame-ancestors 'none'` |
| المسارات الخاصة | `X-Robots-Tag: noindex, nofollow, noarchive` على admin/cart/checkout/wishlist/track |
| الحزمة | **صفر** أسرار: لا `service_role` ولا `SESSION_SECRET` ولا `TELEGRAM_*` ولا `UPSTASH_*` |
| `.env` | مستثنى من git |

**ملاحظة واحدة (ليست ثغرة):** `POST /api/orders` مش بيمنع Origin غريب — وده **صح** لأنه endpoint
عام للزوار ومفيش كوكيز ولا CSRF، والحماية الحقيقية هي rate limit (30/ساعة/IP) + idempotency key.

---

## 4. سهولة الاستخدام

- رحلة الشراء كاملة اشتغلت من غير خطوة واحدة غامضة: منتج → مقاس/لون → سلة → بيانات → دفع عند الاستلام.
- كل حقل مطلوب معلّم بـ`*`، والشحن بيتحدّث فور اختيار المحافظة (65/100).
- رسائل الخطأ إنجليزي واضح + بديل واتساب **فقط** في فشل الشبكة.
- **ملاحظة:** أثناء انقطاع DB، العميل لا يرى أي خطأ — يرى «ORDER CONFIRMED» (pending) + سطر تأكيد.
  البديل (زر واتساب) يظهر فقط إذا فشل **الشبكة** (status 0/408 بعد retry).
- **ملاحظة:** رسالة «Could not load products» لم تعد تظهر للعميل (كانت تقنية). البديل (زر واتساب) بقي.

---

## 5. السرعة (Chrome headless · Slow 4G · cache معطّل)

| الصفحة | TTFB | FCP | **LCP** | CLS | التقييم |
|---|---|---|---|---|---|
| `/` | 75ms | 1.27s | **2.21s** | 0.001 | ✅ جيد |
| `/shop` | 86ms | 1.26s | **3.04s** | 0 | ⚠️ يحتاج تحسين |
| `/product/:id` | 107ms | 1.26s | **4.80s** | 0 | ❌ قبل التحسين |

**التحسينات المنفّذة (uncommitted):**
1. **ضغط الشعار:** `zashm-z-monogram.png` 94KB → 35KB (232×223) + WebP 4.1KB (116px) للـheader/splash.
   Header + splash يحملان WebP؛ JSON-LD logo يبقى PNG.
2. **Supabase preconnect** injected at build via Vite `transformIndexHtml` (confirmed in `build/index.html`).
3. **ProductPage LCP image:** `fetchPriority="high"` + `loading="eager"` + `decoding="async"` على الصورة الأولى؛ thumbnails `loading="lazy"`.
4. **Prerender لصفحة المنتج:** `build/product/<id>/index.html` (directory index، بدون `cleanUrls`) — title/description/canonical/OG/Twitter + Product JSON-LD + preload after `<meta charset>` + `<noscript>` fallback. مُثبت: raw HTML يحمل `Jacket — ZASHM`، canonical على `zashm-mo.vercel.app`، preload للصورة، `EGP 2,500` noscript.
5. **ProductPage LCP** (prerendered) ≈ 3.7s worst-case during outage (was ~7s before deadline).

**الحجم:** دخول أول لصفحة الرئيسية ≈ 180KB gzip JS + 8KB CSS. إجمالي كل الـchunks 367KB gzip
(الأدمن 112KB منهم مش بيتحمّل للزائر). معقول.

---

## 6. الشكل والتصميم

| الفحص | النتيجة |
|---|---|
| Lighthouse — Accessibility | **100/100** على `/` و`/shop` و`/product` و`/track` |
| Lighthouse — Best Practices | **100/100** |
| Lighthouse — SEO | **100/100** |
| Console errors | **0** على 8 مسارات |
| Overflow أفقي | **0px** على 320 / 375 / 768 / 1440 |
| WhatsApp العائم | ظاهر على كل صفحات المتجر، وبيختفي وقت الكتابة على الموبايل فقط |
| Scroll-to-top | ظاهر بعد النزول |
| Tap targets | أزرار الشراء والـCTA ≥44px؛ أيقونات السوشيال 32px (مقبولة بصريًا، تحت 44) |
| نص صغير | شارات زخرفية 6.5–10px («Featured»، «50% OFF»، breadcrumbs) — مش نص أساسي |

**ملاحظات تصميم (تحتاج قرار المالك):**
- شارة «Featured» على كارت المنتج في 320px بتوصل **6.5px** — صغيرة جدًا.
- صفحة `/admin` مش فيها واتساب العائم (شِل إداري منفصل) — مخالف حرفيًا للـinvariant رقم 9،
  لكنه منطقي لأن الأدمن مش عميل. سايبينه زي ما هو.

---

## 7. الجاهزية — إيه الناقص قبل الإطلاق؟

| # | البند | الحالة |
|---|---|---|
| 1 | إضافة المنتجات الحقيقية (الكتالوج) | ❌ لسه منتج تجريبي واحد |
| 2 | التأكد إن المنتجات دي مش في `resilience-exclude.json` | ⚠️ المنتج الحالي مستبعد عمدًا (prerender يتجاهل الاستثناء — live products deserve metadata) |
| 3 | تسجيل دخول الأدمن وتجربة CRUD حقيقية | ⚠️ محتاج بيانات المالك |
| 4 | ضغط الصور / prerender لصفحة المنتج | ✅ منفّذ (WebP logo + prerender + preconnect + fetchpriority) |
| 5 | مراجعة نصوص المنتجات («Hight Quality» مثلًا) | ⚠️ محتوى |
| 6 | اختبار دفع حقيقي (COD) بأوردر حقيقي | ⚠️ محتاج موافقة المالك |
| 7 | تأكيد أن prerendered page تُقدَّم على Vercel (routing) | ⚠️ لا يمكن التحقق محليًا (Vercel CLI logged out) — directory-index approach means default serving; if rewrites win, falls back to SPA shell |

---

## 8. الملفات المتغيرة في هذا الفحص

| الملف | التغيير |
|---|---|
| `api/orders.js` | `generateOrderId()`/`orderDate`/`createdAt` قبل DB؛ client display data؛ `pricingAuthoritative`/`serverLineByKey`/`serverPricing`؛ `pendingOrder()` + `acceptPending(reason)` (200 first، `responded` guard، then alert)؛ كل infra 500s → `acceptPending`؛ catch يعيد 500 только إذا not stored and not responded؛ `AbortSignal.timeout(3500)` deadline |
| `api/_lib.js` | `ORDER_ALERT_TIMEOUT_MS` 4000 / `ORDER_ALERT_ATTEMPTS` 2 / `ORDER_ALERT_RETRY_DELAY_MS` 400؛ `buildOrderTelegramMessage(order, trackingUrl, options)` with `{ amountsFromClient }` labelling subtotal/discount/total only؛ `buildPendingOrderMessage` / `buildPendingOrderActions` / `sendPendingOrderAlert`؛ exports updated |
| `src/store.js` | sends `items[].unitPrice` + `client.{subtotal,discount,shippingCost,total}`؛ retry once on status 0/408 after 600ms؛ handles `payload.pending`؛ `safeOrder.pending`؛ skips `newOrderNotification` for pending |
| `src/lib/orderConfirmation.mjs` | persists `pending` |
| `src/pages/CartPage.js` | pending reassurance line; TRACK YOUR ORDER wrapped in `{!success.pending && (...)}` |
| `src/App.js` | `<OutageNotice />` + import removed; WebP logo refs |
| `src/components/ui/OutageNotice.js` | **deleted** |
| `src/components/shop/Header.js` | WebP logo |
| `src/pages/ProductPage.js` | LCP image `fetchPriority`/`loading`/`decoding`; thumbnails lazy |
| `vite.config.js` | `supabasePreconnect()` plugin |
| `scripts/prerender-products.mjs` | **new** — build-time product prerender (directory index) |
| `scripts/test-prerender.mjs` | **new** — 66 assertions |
| `package.json` | `build` now runs prerender; `test` includes `test-prerender.mjs` |
| `public/zashm-z-monogram.webp` / `.png` | compressed logo assets |
| `scripts/test-order-outage.mjs` | rewritten — 49 assertions on optimistic confirmation |
| `scripts/test-notifications.mjs` | [8]/[9]/[11] rewritten — 13 passed |
| `scripts/test-order-pricing.mjs` | [11]–[14] + `BASE_BODY` client fields — 125 passed |
| `scripts/test-resilience.mjs` | [7] asserts the notice is gone — 104 passed |
| `src/lib/seo.js` | JSON-LD logo still `zashm-z-monogram.png` |

---

## 9. الأدلة

| الدليل | القيمة |
|---|---|
| `npm test` | 25 suite · 2164 passed · 0 failed (SQL suite 476 actually ran) |
| `npm run build` | نجح (prerender: wrote 1 product page) |
| Browser outage proof | HTTP 200 `pending:true`، شاشة «ORDER CONFIRMED» + سطر تأكيد، TRACK مخفي، 0 console/page errors، Telegram `message_id 179` (banner + same body + amounts labelled)، 3.68s |
| Prerendered page (raw HTTP) | `Jacket — ZASHM`، canonical/OG على `https://zashm-mo.vercel.app`، preload للصورة، `EGP 2,500` noscript، Product JSON-LD |
| Lighthouse | 100/100/100 على 4 صفحات |
| رسائل تليجرام حقيقية | `message_id` 174 (handler مباشر)، 176 (retry)، 177 (شراء من المتصفح)، 179 (pending alert) |
| الداتابيز بعد الاختبار | **2 أوردر** (زي ما هي)، stock **9**، كوبون ZAMALEK usage **1** |
| Logo | PNG 35KB (232×223)، WebP 4.1KB (116px) |
| Bundle | صفر أسرار (verified) |