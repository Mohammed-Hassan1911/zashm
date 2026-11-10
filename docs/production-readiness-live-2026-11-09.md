# ZASHM — فحص الجاهزية للإنتاج على الموقع الحي

**التاريخ:** 2026-11-09
**الكوميت:** `main` @ `53a03a9` — CI أخضر (GitHub Actions run `42550069004`)
**الحزمة الحية:** `/assets/index-DtDoRcEM.js` + `/assets/index-BnNeUsC9.css` — مطابقة لبناء `npm run build` المحلي
**البيئة:** macOS، Node v22.22.3، Chrome headless (CDP)، فحوصات إنتاج **قراءة فقط**. لم يُنفَّذ أي SQL ولا تغيير إعدادات ولا نشر.

---

## 1. الحكم

**Conditional Go — الكود جاهز للإنتاج، لكن الإطلاق الفعلي غير مُثبت بعد.**

- لا توجد ثغرة حرجة: لا أسرار في الحزمة، لا قراءة anon لأي جدول حساس، money/stock على السيرفر، 22/22 suite ناجحة، CI أخضر، 0 ثغرات npm.
- **المانع الوحيد الحقيقي:** الكتالوج فارغ (`products = 0`)، فلا يمكن اختبار رحلة الشراء الكاملة على الإنتاج. هذا قيد بيانات/تشغيل، ليس عيب كود.
- بعد إضافة منتج حقيقي واحد وتنفيذ رحلة E2E، يصبح الحكم **Go**.

---

## 2. ما تم إثباته

| الفحص | النتيجة |
|---|---|
| `npm test` | **22 suite · 2081 assertion · 0 failed** — شاملة SQL concurrency على PostgreSQL 17 مؤقت (port 63437) |
| `npm run build` | نجح |
| `npm audit --omit=dev` | 0 vulnerabilities |
| CI على `53a03a9` | **success** |
| فحص أسرار `build/` | لا `service_role` / `SESSION_SECRET` / `TELEGRAM_*` / `UPSTASH_*`؛ الـJWT الوحيد `role: anon`؛ لا `.map` |
| `.env` | مُستثنى في `.gitignore`، ولم يُرفع تاريخيًا |
| مسارات (8) | `/ /shop /cart /checkout /wishlist /track /admin` = 200، مسار مجهول = **404 حقيقي**، `/.env` = 404، `robots/sitemap` = 200 |
| الهيدرز | CSP، HSTS، `X-Frame-Options: DENY`، `nosniff`، referrer، permissions-policy، COOP |
| المسارات الخاصة | `X-Robots-Tag: noindex, nofollow, noarchive` على cart/checkout/wishlist/track/admin |
| API إداري | 401 بدون جلسة، 401 بـBearer مزوّر، 405 لأسلوب غير مسموح |
| `POST /api/auth` | بيانات خاطئة → 401 `{"error":"Invalid credentials"}` (رسالة عامة) |
| `POST /api/coupons/validate` | كود خاطئ → 200 `{valid:false}` بلا تفاصيل |
| `GET /api/orders?...` | رمز تتبع خاطئ/غائب → 200 `{found:false}` (لا تسريب) |
| CORS | يعكس فقط `https://za-shm.vercel.app` مع `Vary: Origin` |
| متصفح: 4 عروض × 8 مسارات | **0 console errors، 0 horizontal overflow** (320/375/768/1440) |
| Empty states | Home: «New pieces are on their way»؛ Shop: «No Products Found»؛ Cart/Checkout: «Your bag is empty»؛ Wishlist: «Nothing saved yet» |
| Floating actions | WhatsApp ظاهر (z 30000)؛ Scroll-to-top يظهر بعد 300px ويختفي عند القمة (44×44)؛ يختفي WhatsApp عند الكتابة على ≤768 ويعود بعد blur |
| Header على 320 | Wishlist + Bag ظاهران، Mobile nav ظاهر |
| Admin | شاشة دخول (email + password + Sign In) بلا أخطاء console |
| Admin grid | الإصلاح الحي: `admin-product-card`، overlay مخفي حتى hover/focus/selection، لا كلاس المتجر القديم |
| 404 | عنوان «Page Not Found»، meta noindex، لا canonical |

---

## 3. تحقق قاعدة البيانات (قراءة فقط)

استُخدم مفتاح service-role محليًا لاستعلامات **عدّ/أعلام فقط**، بلا أي تعديل:

| العنصر | القيمة |
|---|---|
| `products` | **0** |
| `orders` | **0** |
| `coupons` | **0** |
| `product_reviews` | **0** |
| `users` | **2** — كلاهما `admin` (لم يُلمسا) |
| `zshm_deploy_flags` | `products_public_phase1_applied` + `products_public_frontend_live` (أي Phase 3 lockdown فعّال) |
| `users.session_version` | موجود (0 و13) |
| `zshm_rate_limits` | الجدول موجود وفيه صفوف؛ RPC `zshm_rate_limit` يعمل لـservice_role و**مرفوض لـanon** |
| `products` أعمدة | `reservedStock`/`variantStock`/`tags`/`active` موجودة (0 صفوف، فلا مخزون سالب) |

**Anon probes:** `products` / `users` / `orders` / `coupons` / `product_reviews` / `zshm_rate_limits` = **401**.
**`products_public`:** 200، ويسمح فقط بالأعمدة المعتمدة؛ `reservedStock`/`tags`/`active` = **400 (غير موجودة في العرض)**.

> الخلاصة: Phase 3 مطبَّق فعلاً، وrate limiting المشترك يعمل عبر PostgreSQL حتى بدون Upstash.

---

## 4. ما لم يُثبت (وأسبابه)

1. **رحلة شراء E2E حية** — لا يوجد منتج. لا يمكن اختبار: إضافة للسلة → checkout → كوبون → طلب → تأكيد → لوحة الطلبات → تغيير الحالة → رابط التتبع → إلغاء/استعادة مخزون.
2. **دخول الأدمن + CRUD منتج + رفع صورة** — لا توجد بيانات دخول. النموذج يعمل، لكن نجاح الجلسة والرفع لم يُختبر.
3. **إشعار Telegram** — `TELEGRAM_BOT_TOKEN/CHAT_ID` غير متاحين محليًا (الاختبارات تتخطى برسالة واضحة).
4. **متغيرات Vercel** — لا جلسة Vercel CLI؛ لا فحص لـ`UPSTASH_*`/`VITE_GA_ID`/`TRACKING_TOKEN_TTL_HOURS`.
5. **Storage bucket** — سرد anon يعيد «Bucket not found» (السرد ممنوع)؛ وجود الـbucket وقواعد الرفع لا يُؤكدان بدون أدمن.
6. **RLS/grants بالكامل** — anon 401 يثبت المنع، لكن تعريفات السياسات نفسها تحتاج `verify_production_security.sql` أو Management API.
7. **TTFB** — من هذه البيئة تراوح 0.57–5.45s (متغيّر جدًا)؛ ليس مقياسًا موثوقًا. القياس السابق من شبكة أخرى كان 85–121ms.

---

## 5. ملاحظات P2 (ليست مانعة)

**تم إصلاح ما يلي في الكوميت `3e91f00` والتحقق منه على الإنتاج:**

- ✅ **JSON-LD:** أضيف `Organization` + `WebSite` مرة واحدة من هيكل التطبيق؛ صفحة المنتج تحتفظ بـ`Product` منفصل.
- ✅ **Home `<h1>`:** أصبح `h1` معنويًا مخفيًا بصريًا («ZASHM — Luxury Menswear») والشعار بقى عنصرًا زخرفيًا `div`.
- ✅ **Skip link:** «Skip to content» يظهر عند أول Tab وينقل التركيز إلى `main#main-content`.
- ✅ **حد الطلبات:** ارتفع من 10 إلى **30/ساعة/IP** لتقليل حظر عملاء CGNAT، مع بقاء idempotency والتحقق من المخزون على السيرفر.
- ✅ **Lighthouse (الرئيسية، إنتاج):** Accessibility 100، Best Practices 100، SEO 100، بدون أخطاء console أو overflow.

**ما زال مطلوبًا من المالك (ليس كودًا):**

- **لا بريد تأكيد للعميل** — التأكيد على الشاشة + رابط تتبع + WhatsApp فقط؛ الإشعار للمالك عبر Telegram.
- **الدفع:** COD فقط؛ البطاقة «COMING SOON».
- **GA4 غير مفعّل** (لا `VITE_GA_ID` في الحزمة).
- **الصور:** الضغط client-side إلى <900KB موجود؛ الأداء الفعلي يحتاج صورًا حقيقية.
- **السلة القديمة:** محاكاة سلة فيها منتج محذوف تُظهره وتسمح بالضغط على PLACE ORDER (السيرفر يرفضه)؛ يجب على المالك مسحها.

---

## 6. خطة الإطلاق (بالترتيب)

1. **أضف منتجًا حقيقيًا واحدًا** من `/admin` (بحساب admin الموجود). إن فشل الدخول، أعد تعيين كلمة المرور من Supabase.
2. **امسح السلة القديمة** في متصفح المالك: `/cart` → أيقونة الحذف، أو Clear site data.
3. **أكّد Telegram** (اختياري لكن موصى به): `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` على Vercel Production/Preview.
4. **Upstash اختياري:** الـDB fallback مُثبت ويعمل؛ أضف Upstash فقط لتقليل حمل Postgres.
5. **أرسل لي إشارة بعد وجود المنتج** → أنفّذ E2E كامل على الإنتاج وأعطيك **Go/No-Go** نهائي.
6. قبل الحملة: أضف `VITE_GA_ID` إن أردت تحليلات. (حد الطلبات أصبح 30/ساعة/IP في `3e91f00`.)

---

## 7. الملفات والكوميت

- كوميت إصلاحات P2: `3e91f00` — «fix(a11y,seo): add skip link, site JSON-LD and home h1; raise order rate limit».
- الملفات: `src/lib/seo.js`, `src/App.js`, `src/pages/HomePage.js`, `src/index.css`, `api/orders.js`, `scripts/test-final-hardening.mjs`.
- `npm test`: 22 suites، 0 failed (بما فيها SQL على PostgreSQL 17). `npm run build`: ناجح. CI: ناجح.
- الحزمة الحية: `assets/index-nNcV0vZK.js` + `assets/index-CuPjY0oc.css`، ومطابقة للبناء المحلي.
- هذا الملف محلي وغير مُلتزم.

---

## 8. تحديث 2026-11-10 — بعد إضافة أول منتج وأول أوردرين

### 8.1 حالة البيانات (قراءة فقط، service-role)

| العنصر | القيمة |
|---|---|
| `products` | **1** — Jacket، `active`، 4 صور، `stock` 9 |
| `orders` | **2** — كلاهما `Pending` (Dakahlia 2,565 / New Valley 2,400) |
| `users` | **2** — admin فقط |
| `coupons` | **1** — `ZAMALEK` (fixed 200، `usageCount` 1) |
| `product_reviews` | 0 |
| Storage `products` | 6 objects، 0.88 MB |

### 8.2 E2E جزئي (قراءة فقط — بدون إنشاء أو تعديل)

تم التحقق من البيانات المخزّنة وإعادة بناء رسالة التلجرام بنفس دالة الإنتاج:

| الفحص | النتيجة |
|---|---|
| `ZSH-MW9ME7DE` (Dakahlia) | شحن **65**، الإجمالي 2,565 = 2,500 + 65 ✅، المتبقي عند الاستلام 2,500 ✅ |
| `ZSH-MW9V3XWX` (New Valley) | شحن **100**، الإجمالي 2,400 = 2,500 − 200 + 100 ✅، المتبقي عند الاستلام 2,300 ✅ |
| بلوك دفع الشحن | ظاهر في الرسالتين بالرقم `01013380313` والمبلغ الصحيح لكل محافظة ✅ |
| رابط التتبع | `/api/orders?track=…&tk=…` = **200** `access: full` للأوردرين ✅ |
| توكن خاطئ | `{"found":false}` ✅ |
| المخزون | `variantStock` مجموعه 9 = `stock` 9، وبيع قطعتين M/Black ⇒ متبقي 2 ✅ |
| الكوبون | `usageCount` = 1 (أوردر واحد استخدمه) ✅ |

**لم يُثبت بعد:** تسليم رسالة Telegram فعليًا (يحتاج نظر المالك في Telegram)، ودخول `/admin`، وإنشاء أوردر جديد من المتصفح.

### 8.3 النسخ الاحتياطي

- أُضيف `scripts/backup-data.mjs` (+ `npm run backup`) واختباره `scripts/test-backup-data.mjs` (31 اختبارًا).
- أول نسخة كاملة: `backups/2026-11-10T00-07-44Z/` (الجداول الخمسة + manifest + 5 صور).
- التفاصيل والاسترجاع: `docs/backup-and-restore-ar.md`.
- `backups/` مضاف إلى `.gitignore` — يحتوي بيانات عملاء ولا يُرفع.

### 8.4 snapshot المنتجات

- المنتج الحالي (Jacket `1794232720755261`) **مستبعد** من الـsnapshot لأنه منتج تجريبي، وهو لسه **حي** في المتجر (`products_public` = 1).
- `scripts/resilience-exclude.json` بقى فيه الـid ده بدل الـid القديم غير الموجود.
- النتيجة: `public/catalog-snapshot.json` فاضي (`count: 0`) و`public/media/` فاضي (اتمسحت 5 صور / 0.88 MB بـ`--prune`).
- الاستبعاد **مش** مسح من الداتابيز: المنتج بيتعرض عادي، بس مش داخل النسخة الاحتياطية.
- لما تضيف منتج حقيقي: شيل الـid من `scripts/resilience-exclude.json` ثم `npm run resilience:sync -- --prune`.

