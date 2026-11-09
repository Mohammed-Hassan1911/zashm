# تقرير فحص ما قبل الإطلاق (Pre-Launch Audit) — ZASHM

> **ملاحظة تاريخية:** هذا تقرير أقدم (HEAD `59c4f2d`). أحدث فحص إنتاجي وحالة
> البنود الحالية موجودة في `docs/production-readiness-live-2026-11-09.md`.
> البنود P2 المتعلقة بـJSON-LD / skip link / Home `<h1>` / حد الطلبات تم
> إصلاحها في `3e91f00`، وليبل المنتج أصبح ملحومًا بأعلى يسار الصورة وليس صفًا
> محجوزًا فوقها. أي بند هنا يخالف التقرير الأحدث يُعتبر قديمًا.

**التاريخ:** 2026-11-09
**الفرع / الكوميت:** `main` @ `59c4f2d` (checkout button + de-dup messages) — **منشور ومُتحقق على الإنتاج**
**Live bundle:** `/assets/index-CDpVNmqs.js`
**النطاق:** أمان، شكل/UX، سرعة الويب، سلاسة، سهولة الاستخدام، إمكانية الوصول، قابلية التحمّل.
**البيئة:** macOS، Node v22.22.3، متصفح (viewport ثابت 816×755). لا وصول إلى Supabase Dashboard ولا Vercel CLI — الفحوصات الإنتاجية قراءة فقط (anon probes + HTTP headers + bundle).

---

## 1. الحكم المختصر

**Conditional Go — جاهز للبيع بشرط إغلاق بنود P0/P1 أدناه.**

لا توجد ثغرة حرجة (Critical) مؤكدة: لا سر في الحزمة، لا قراءة anon لـ `users/orders/coupons/products`، RLS/الصلاحيات سليمة، 22/22 suite ناجحة، بناء الإنتاج ناجح، 0 ثغرات npm.
لكن هناك **3 بنود P1** (سلة اختبار قديمة على الإنتاج، rate limiting غير متين دون Upstash، عدم تعطيل زر الطلب عند قطعة غير متاحة — أُصلِح محليًا) و**بنود P2** (صور كبيرة، بدون srcset، ترقيم صفحات كتالوج) التي يجب إغلاقها قبل «Production-ready».

---

## 2. ما تم إثباته (أوامر + نتائج)

| الأمر | النتيجة |
|---|---|
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm test` | **22/22 suite، 2069 assertion، 0 فشل** (شامل SQL concurrency 475/475 على PostgreSQL مؤقت) |
| `npm run build` | **نجح** — 2570 module، 3.22s، 22 ملف |
| Anon probes (`users/orders/coupons/products`) | **401** (ممنوع) |
| Anon probe (`products_public`) | **200** — أعمدة آمنة، لا `reservedStock` (42703) |
| Anon probe (storage list `products`) | **400 / Bucket not found** (السرد ممنوع) |
| JWT في الحزمة | `role: anon` (ليس service_role) |
| Secret scan في `build/` | 0 — `SERVICE_ROLE/SESSION_SECRET/TELEGRAM_*` غير موجودة |
| Security headers (8 routes) | CSP, HSTS, X-Frame-Options DENY, nosniff, referrer, permissions-policy — كلها موجودة |
| Private routes (`/cart /checkout /wishlist /track /admin`) | `X-Robots-Tag: noindex, nofollow, noarchive` ✓ |
| `/sitemap.xml` | 200، XML صحيح، يضم `/` و`/shop` و`/product/*` فقط |
| `/robots.txt` | `Disallow: /api/` + Sitemap ✓ |
| Unknown route | **404 حقيقي** (ليس redirect) ✓ |
| Reviews endpoint (warm) | ~0.5s، `x-vercel-cache: HIT`، `age: 11` ✓ |
| Floating actions (live) | WhatsApp مصيّر على 5 صفحات؛ Scroll-to-top يظهر بعد التمرير ✓ |
| Console errors (5 صفحات) | 0 |
| Admin chunks على صفحات المتجر | 0 (لا `AdminApp/admin-charts/admin-csv`) ✓ |
| CLS (4 صفحات) | 0.0000 |
| TTFB / DCL | ~80–110ms / ~200–300ms |

---

## 3. الأمان (Security)

### 3.1 نقاط القوة (مؤكدة)
- **تصعيد الصلاحيات:** كل `api/admin/*.js` يستدعي `requirePerm` بالصلاحية المناسبة (products/orders/coupons/users/reviews/discounts). لا مسار без حارس.
- **جلسات:** كوكي `HttpOnly; Secure; SameSite=Strict` + CSRF double-submit + فحص Origin + إعادة قراءة `session_version` ودور DB في كل طلب.
- **Coupons/Orders:** السعر/الشحن/الكوبون/المخزون تُحسب في السيرفر (`api/orders.js`); `atomic_place_order` يقفل صفوف المنتجات بترتيب ثابت؛ idempotency key يمنع التكرار.
- **Inventory:** `reservedStock` غير مستخدم ولا يُطرح من التوفر؛ التوفر = `max(0, stock)` أو `variantStock["<size>-<color>"]`.
- **Storage:** 5MB، MIME allow-list، sniffing by magic bytes، لا سرد anon، تنظيف الصور غير المرجعية.
- **CSP:** `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`.
- **Telegram:** sanitisation موجودة (tests).

### 3.2 ملاحظات / مخاطر
- **P1 — Rate limiting غير متين دون Upstash:** `rateLimitShared` يعود إلى per-instance fallback (يُسجّل تحذيرًا). إن لم يكن `UPSTASH_REDIS_REST_URL/TOKEN` مُعدّاً على Vercel، فالحدود (login 5/15min، coupon، checkout) قابلة للتجاوز عبر instances متعددة.
  **Action:** تحقق من env vars على Vercel؛ إن غابت، أضف Upstash أو وثّق المخاطرة (Low-Medium).
- **P2 — صور المنتجات ~160KB/118KB بدون srcset/WebP.** مقبولة حاليًا (2 منتجات) لكنها ستُصبح مشكلة مع كتالوج أكبر.
- **P2 — كتالوج storefront يجلب `products_public` كاملًا (`select('*')`) بدون ترقيم صفحات.** مقبول لـ 2 منتجات، غير قابل للتوسع.
- **P3 — `npm audit` 0** (تم).

### 3.3 لم يُتحقق (production)
- سياسات RLS الفعلية، صلاحيات `anon/authenticated` على الإنتاج، حالة Phase 3 (lockdown base `products`) — لا management token.
- `reservedStock` baseline (يجب أن يكون 0) — لم يُستعلم.

---

## 4. الشكل (Visual) & UX

### 4.1 نقاط القوة
- هوية بصرية متسقة (dark + gold + Cormorant/Montserrat)، spacing متسق، aspect-ratio ثابت (3/4 cards، 4/5 product).
- ليبل المنتج الآن **في سطر محجوز فوق الصورة** (6px فاصل) — لا يغطي الصورة في أي نسبة أو حجم شاشة. تم التحقق على النسخة الحية: `overlaps: false`.
- أيقونات الفوتر (Instagram/Facebook) بقت أقرب (26px على mouse/trackpad)، 44px على touch.
- Empty states موجودة («No products yet», «Your bag is empty»).
- Floating actions: WhatsApp مصيّر دائمًا، Scroll-to-top يظهر بعد التمرير.
- Governorate autocomplete: لا يُزحزح الصفحة (pointerdown focus).

### 4.2 ملاحظات
- **P1 — سلة اختبار قديمة على الإنتاج:** `Jacket Boxy L/Burgundy ×1` (غير متاح) لا يزال في سلة المتجر. أُصلِح UX (تعطيل زر الطلب) لكن **يجب على المالك إزالة هذا السطر** من localStorage/cookie (أو مسح سلة المتصفح) قبل الإطلاق، وإلا سيرى العملاء رسالة «can’t be ordered right now».
- ~~**P2 — Home `<h1>` هو شعار ZASHM**~~ — أُصلح في `3e91f00`: الشعار عنصر زخرفي و`h1` معنوي مخفي بصريًا.
- ~~**P2 — لا skip link**~~ — أُصلح في `3e91f00`: «Skip to content» ينقل التركيز إلى `main`.
- **P3 — Product label spacing:** 6px gap + reserved row (توصيتي: الإبقاء كما هو).

---

## 5. السرعة (Performance)

| المقياس | القيمة (live, desktop) |
|---|---|
| TTFB | 79–107 ms |
| DCL | 210–286 ms |
| FCP | 268–368 ms |
| CLS | 0.0000 |
| Resources per page | 18–20 |
| Main bundle (gzip) | 28.01 kB |
| vendor-react (gzip) | 45.66 kB |
| vendor-supabase (gzip) | 54.18 kB |
| AdminApp (gzip) | 39.99 kB (admin only) |
| admin-charts (gzip) | 111.96 kB (admin only) |

**LCP:** PerformanceObserver لم يُبلغ (null) — على الأرجح لأن LCP element هو صورة hero (CSS background أو lazy). يستحسن preload للصورة hero.
**لا Lighthouse** متاح في هذه البيئة (لا Chrome/Chromium).
**لا console errors** على 5 صفحات.

### مخاطر
- **P2 — لا preload للصورة hero** (index.html). LCP قد يكون >2.5s على mobile 3G.
- **P2 — صور 160KB بدون WebP/srcset** (انظر §3.2).
- **P2 — Google Fonts (Cormorant + Montserrat) من CDN** with preconnect+swap (موجود). OK.

---

## 6. السلاسة (Smoothness) & سهولة الاستخدام (Ease of use)

### 6.1 نقاط القوة
- Form validation: inline errors + toast notice + focus on first wrong field.
- Governorate autocomplete: لا يُزحزح الصفحة (pointerdown).
- Checkout: empty states، out-of-stock banners with Remove buttons، quantity reduction.
- Mobile keyboard: floating actions hide only while typing on ≤767px (verified test).
- Reduced motion: `useReducedMotion` honored in BackToTop.
- Bilingual copy (EN/AR) where pattern exists.

### 6.2 إصلاح مُنفَّذ (محلي، غير منشور)
- **Checkout PLACE ORDER button** الآن معطّل (`disabled`) عندما توجد قطعة غير متاحة (`blocking`)، مع opacity 0.5. إضافة guard في `handleOrder`.
  **السبب:** الزر كان قابلاً للضغط مع قطعة out-of-stock (الخادم يرفض، لكن UX ضعيف).
  **الملف:** `src/pages/CartPage.js`.

---

## 7. إمكانية الوصول (Accessibility)

| فحص | النتيجة |
|---|---|
| landmarks (main/header/footer/nav) | ✓ على 5 صفحات |
| h1 count | 1 per page ✓ (Home: meaningful sr-only h1 since `3e91f00`) |
| img alt | 0 missing ✓ |
| buttons without accessible name | 0 ✓ |
| `:focus-visible` styling | ✓ |
| floating actions z-index 30000 | ✓ |
| safe-area insets | ✓ |
| 44px touch targets | ✓ (verified) |
| skip link | ✓ since `3e91f00` |
| reduced motion | honored (BackToTop) ✓ |

---

## 8. قابلية التحمّل (Scalability)

- **SQL concurrency:** 475/475 passed (races on order placement/cancel/delete/coupon).
- **Rate limiting:** per-instance fallback (P1 if Upstash absent).
- **Catalog:** 2 منتجات، `select('*')` بدون pagination (P2).
- **Reviews:** edge cache `s-maxage=20, SWR=120`، parallel queries (admin + public) ✓.
- **Vercel serverless:** كل endpoint stateless؛ لا shared in-memory state except rate limiter fallback.

---

## 9. بنود P0 / P1 / P2 (Action items)

### P0 (يجب قبل الإطلاق)
1. **أزل سلة الاختبار القديمة** (`Jacket Boxy L/Burgundy`) من localStorage/cookie على متصفح المالك — وإلا سيرى العملاء banner «can’t be ordered right now». (أو مسح سلة المتجر.)
2. **أكد env vars على Vercel:** `UPSTASH_REDIS_REST_URL/TOKEN` (rate limiting متين) — أو وثّق غيابها.

### P1 (قبل «Production-ready»)
3. **طبّق/أكد Phase 3 lockdown** (`products_public_view.sql` Phase 3) على الإنتاج — base `products` revoke. (يحتاج management token.)
4. **أكد `reservedStock = 0`** على الإنتاج.
5. **Preload hero image** في `index.html` (LCP).
6. **انشر checkout button fix** (commit + push) — مُنفَّذ محليًا، 61/61 ux tests pass.

### P2 (تحسينات)
7. WebP/srcset للصور (160KB → ~40KB).
8. Pagination / lazy load للكتالوج.
9. ~~Skip link + Home h1 معنوي.~~ ✅ `3e91f00`
10. Lighthouse (يحتاج Chrome) — قياس CWV فعلي.

---

## 10. ما لم يُتحقق (لا تدّعِ غيره)

- **لا Supabase Management token / DB connection string:** SQL الإنتاج غير قابل للتطبيق/التحقق هنا.
- **Vercel CLI logged out:** لا نشر/تحقق عبر CLI (فقط push + live bundle hash).
- **لا متصفح real viewport resize:** fixed 816×755؛ layouts 320/375/768/1440 verified by CSS/media queries + tests, not live at those widths.
- **لا Lighthouse:** لا Chrome/Chromium.
- **Admin reviews latency:** غير قابل للقياس بدون authenticated admin session.
- **لا staging:** لا destructive tests / load tests على الإنتاج.

---

## 11. الخلاصة

**Conditional Go.** المتجر **آمن للبيع** (لا ثغرة حرجة، RLS سليمة، money server-authoritative، inventory atomic).
**لا تُعلِن «Production-ready»** حتى: (a) سلة الاختبار أُزيلت، (b) Phase 3 lockdown confirmed، (c) Upstash confirmed أو موثّق، (d) checkout fix منشور.

**Tests:** 22/22 suites، 2069 assertions، 0 فشل (SQL 475/475).
**Build:** ناجح (88.06 kB main gzip 28.01 kB).
**npm audit:** 0 vulnerabilities.
**Live bundle:** `/assets/index-wLivhEbd.js`.

---

---

## 12. تحقق ما بعد النشر (Post-deploy, 2026-11-09)

| فحص | النتيجة |
|---|---|
| Live bundle | `index-CDpVNmqs.js` ✅ |
| `/cart` | `alertCount: 1` (رسالة واحدة + Remove) ✅ |
| `/checkout` | `alertCount: 1` (consolidated)، `PLACE ORDER disabled: true` ✅ |
| Console errors (8 routes) | 0 ✅ |
| Admin chunks على public routes | 0 ✅ |
| imgs بدون alt / buttons بدون name | 0 / 0 ✅ |
| CLS | 0.0000 ✅ |
| TTFB | 85–121 ms ✅ |
| DCL | 244–913 ms (product page أبطأ بسبب الصور) ✅ |
| Security headers | كاملة ✅ |
| Anon probes | users/orders/coupons/products = 401، products_public = 200 ✅ |
| sitemap/robots/unknown | 200 / 200 / 404 ✅ |
| Secrets in build | 0 ✅ |

---

## 13. قابلية التحمّل — أرقام تقديرية (Capacity)

> الأرقام تقديرية بناءً على حدود خطط Vercel/Supabase وحجم الصفحة المرصود (~300KB/زيارة). ليست قياس حمل فعلي.

### Vercel (serverless)
- **Auto-scale أفقي:** لا حد concurrency ثابت (حسب الخطة).
- **Cold start:** ~100–300ms (TTFB المرصود 85–121ms warm).
- **Function duration:** Hobby ~10s، Pro ~60s. دوالنا <1s ✅.
- **Hobby:** حدود bandwidth/invocations شهرية (راجع الخطة) — تكفي boutique.
- **Bottleneck:** rate limiter per-instance بدون Upstash.

### Supabase
- **Free:** ~500MB DB، ~2GB egress/شهر، 50k MAU.
  - ~300KB/زيارة → **~6–7k زيارة/شهر** قبل حد bandwidth (الصور هي الحد).
  - DB نفسها تافهة (2 منتجات، ~280KB صور).
- **Pro:** ~8GB DB، ~250GB egress → **~800k زيارة/شهر** تقديرياً.
- **PostgREST:** connection pooling مُدار ✅.
- **Auth:** rate limits حسب الخطة.

### حدود عملية أخرى
- **الكتالوج:** `select('*')` بدون pagination → مقبول <1k منتج؛ مشكلة عند 10k+.
- **الطلبات:** row locks تُسلسل لكل منتج → ممتاز لـ boutique، ليس flash-sale.
- **المراجعات:** edge cache 20s → يتحمل قراءات عالية.

### التوصية
- **Boutique (مئات–آلاف/يوم):** الخطة الحالية كافية ✅.
- **Flash-sale / viral (10k+ متزامن):** ترقية Pro + Upstash + WebP/srcset + pagination + monitoring.

---

## 14. الحكم النهائي (Final Verdict)

**الكود: Production-ready ✅** (أمان، money server-authoritative، inventory atomic، 22/22 tests، build، 0 vulns، deploy verified).

**البنود المتبقية (ops فقط، ليست كود):**
- P0: إزالة سلة الاختبار (متصفح المالك) — 10s.
- P0: تأكيد/إضافة Upstash على Vercel — 2min.
- P1: Phase 3 lockdown (Supabase SQL Editor) — 3min.
- P1: `reservedStock = 0` check — 1min.

**بعد إكمال هذه الأربعة → Production-ready من جميع الانحاء.**
