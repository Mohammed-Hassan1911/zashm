# ZASHM — تسليم معالجات جاهزية الإنتاج (محلي فقط)

**التاريخ:** 2026-11-01  
**الفرع:** `main`، الأساس `a0e78f4`، **كل تغييرات هذا التسليم غير مُنشورة وغير مُلتزمة (uncommitted)**.  
**المرجع:** `docs/production-readiness-audit-2026-11-01-ar.md` (خصوصًا §11) و`docs/security-production-checklist.md`.

---

## 0. نطاق هذا التسليم وحدوده

**ما تم:** تنفيذ كل الإصلاحات الآمنة التي يمكن إنجازها داخل المستودع، وإضافة اختبارات، وبناء الإنتاج، وتجهيز تعليمات دقيقة لكل ما يحتاج إنتاجًا.

**ما لم يتم ولن يُدّعى:**

- لم يُنفَّذ أي SQL على Production أو Preview.
- لم تُعدَّل أي بيانات إنتاج (لا مستخدمون، لا طلبات، لا منتجات، لا كوبونات).
- لم تُغيَّر أي متغيرات بيئة أو إعدادات في Vercel أو Supabase Dashboard.
- لم يحدث `commit` أو `push` أو `merge` أو نشر.
- لا يمكن اعتبار المشروع «Production-ready» بمجرد نجاح الاختبارات المحلية. الحكم بقي **Conditional Go** حتى تكتمل الفحوصات اليدوية في §5.

**قاعدة الأسرار:** لا يحتوي هذا الملف على أي سر أو توكن أو كلمة مرور أو بيانات عميل. كل القيم الحساسة تبقى في لوحات الإنتاج فقط.

---

## 1. ملخص الحالات

| الحالة | العدد | المعرّفات |
|---|---|---|
| **FIXED LOCALLY AND TESTED** | 20 | S-02, S-03, S-09, S-11, S-16, S-17, F-01, F-02, F-03, F-04, F-05, F-07, F-10, M-01, M-03, M-05, M-06, M-07, M-08, H-01 (+ L-01, L-02, L-04, L-05 المكافئة) |
| **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | 7 | S-10, S-12, S-13, H-02, H-03, H-04, M-04 |
| **BLOCKED** | 3 | F-13, O-12/L-10, والتحقق الإنتاجي لـ S-13/H-03 |
| **ACCEPTED RISK / NO CHANGE** | الباقي | S-01, S-04, S-05, S-06, S-07, S-08, S-14, S-15, S-18, S-19, S-20, O-01…O-11, O-13, O-14, F-06, F-08, F-09, F-11, F-12, M-02, L-03, L-06…L-09 |

> الأعداد أعلاه إرشادية لأن بعض المعرّفات مترابطة (F-01 = H-01، M-05 = F-02، إلخ). المصفوفة الكاملة المعتمدة هي §11 في تقرير المراجعة، ولا تعارض بينها وبين هذا الملف.

---

## 2. الملفات المتغيرة وماذا تغيّر

### 2.1 كود التطبيق

| الملف | التغيير | البند |
|---|---|---|
| `api/admin/products.js` | إضافة `GET /api/admin/products` محمي بـ`requirePerm('products.read')`، service role، صفوف كاملة، ترتيب `id desc`، rate limit، وأخطاء عامة لا تكشف DB. تسجيل المسار وتصدير `listProducts`. | H-01 / F-01 / F-10 / M-06 |
| `src/store.js` | إضافة `adminProducts` + `adminProductsLoading/LoadStatus/Error` + `refreshAdminProducts`، وتطبيع صفوف مشترك `normalizeProductRow`، وتحديث القوائم بعد كل عملية منتج. المتجر بقي على `products_public`. | H-01 |
| `src/pages/AdminApp.js` | `ProductsPanel` و`Dashboard` يقرآن `adminProducts`، إضافة `tags` إلى النموذج و`openEdit`، شارة `INACTIVE`، وحالات تحميل/خطأ/Retry. | H-01 / F-01 / F-10 / M-06 |
| `api/auth.js` | عند logout: قراءة الجلسة، ورفع `users.session_version` إن وُجد العمود (إبطال كل جلسات المستخدم)، ثم مسح الكوكيز. لا يفشل logout بسبب خطأ DB. | S-09 / M-01 |
| `api/_lib.js` | rate limiter محدود (`RATE_BUCKET_MAX=10000`) مع sweep وإخلاء الأقدم، مهلة Upstash 1.5s + `AbortSignal`، كشف خطأ كل أمر عبر `redisValue`، إصلاح TTL=-1، تحذير مُقيّد. توكنات تتبع اختيارية `v1.<exp>.<sig>` مع بقاء 32-hex القديمة صالحة. | S-10/S-11 / H-04 / M-03 |
| `src/pages/ShopPage.js` | شريط خطأ + Retry عند فشل تحميل المنتجات، وفرز «Best Seller» حسب `label` بدل `sales` غير الموجود. | F-02/F-03 / M-05 / L-01 |
| `src/pages/HomePage.js` | شريط خطأ + Retry. | F-02 / M-05 |
| `src/pages/TrackOrder.js` | توضيح أن التتبع يتطلب الرابط الآمن مع `tk`، وتغيير الـ placeholder. | F-04 / M-07 |
| `src/components/admin/ImageUploader.js` | `alt` لمعاينة الصور. | F-05 / L-02 |
| `src/lib/security.js` | `PERMISSIONS` و`hasPermission` كمصدر واحد مُصدَّر، مع `dashboard.read`. | F-07 / L-04 |
| `src/lib/auth.js` | يستورد `hasPermission` الموحّد بدل خريطة مكررة. | F-07 / L-04 |

### 2.2 SQL والإعداد والتوثيق والاختبارات

| الملف | التغيير | الحالة |
|---|---|---|
| `supabase/products_public_view.sql` | تسجيل `products_public_phase1_applied` بعد Phase 1؛ Phase 3 يرفض التنفيذ إذا غاب العرض/صلاحية anon/تطابق الصفوف/ظهور `reservedStock`؛ تنبيه عند وجود RLS SELECT policies. | **مُعدّ — لم يُنفَّذ على الإنتاج** |
| `supabase/verify_production_security.sql` | **جديد.** 14 استعلامًا للقراءة فقط (SELECT فقط) لفحص الملكية، تعريف العرض، الأعمدة، grants، RLS، counts، flags، session_version، Storage، الوظائف، والفهارس. | **جاهز — لم يُنفَّذ** |
| `.github/workflows/ci.yml` | **جديد.** PostgreSQL tools + `ZSHM_REQUIRE_SQL_TESTS=1` + `npm ci` + `npm test` + `npm run build`. | **جاهز — لا يعمل قبل commit/push** |
| `scripts/test-admin-products.mjs` | **جديد.** 18 اختبارًا للمسار الإداري. | ناجح |
| `scripts/test-sessions-admin.mjs` | اختبار إبطال الجلسة عند logout. | ناجح |
| `scripts/test-edge-transport.mjs` | اختبارات rate limiter (خطأ أمر، HTTP، AbortSignal، حدود). | ناجح |
| `scripts/test-final-hardening.mjs` | اختبارات توكن التتبع المنتهي + التوافق الخلفي. | ناجح |
| `.env.example` | توثيق `VITE_*` (و`REACT_APP_*` كبديل)، `UPSTASH_*`، `TRACKING_TOKEN_TTL_HOURS`، وفصل أسرار السيرفر. | مكتمل |
| `package.json` | إضافة `test-admin-products.mjs` إلى `npm test`. | مكتمل |
| `docs/security-production-checklist.md` | تحديث فجوة لوحة المنتجات، حراسة Phase 3، Upstash، إبطال الجلسة، Storage، CI، وعبارة «لم يُطبَّق شيء تلقائيًا». | مكتمل |
| `docs/production-readiness-audit-2026-11-01-ar.md` | إضافة §11 (مصفوفة كل المعرّفات) وتصحيح §5.1/§6. | مكتمل |

---

## 3. الاختبارات والنتائج (محلية)

| الأمر | النتيجة |
|---|---|
| `ZSHM_REQUIRE_SQL_TESTS=1 npm test` | **918 passed, 0 failed** — 10 مجموعات: 81 + 90 + 80 + 79 + 74 + 18 + 97 + 126 + 25 + 248 |
| `node scripts/test-admin-products.mjs` | **18 passed, 0 failed** |
| `node scripts/test-sessions-admin.mjs` | **74 passed, 0 failed** |
| `node scripts/test-edge-transport.mjs` | **97 passed, 0 failed** |
| `node scripts/test-final-hardening.mjs` | **126 passed, 0 failed** |
| `node scripts/test-sitemap.mjs` | **25 passed, 0 failed** |
| `node scripts/test-sql-concurrency.mjs` | **248 passed, 0 failed** — PostgreSQL 17 محلي مؤقت، لا اتصال بالإنتاج |
| اختبار متصفح محلي | **PASS** — المسارات العامة و404 عند 320 و390 و1440px، بلا أخطاء صفحات أو overflow |
| `npm run build` | **PASS** — Vite 7.3.7، 2555 module |

**خط الأساس قبل المعالجة:** 783 اختبارًا ناجحًا + build PASS. الزيادة 34 اختبارًا.

**ما لا تثبته هذه الاختبارات:** أي سلوك إنتاجي، أو سياسة RLS/تعريف عرض حقيقي، أو مسارات API حية على Preview/Production.

---

## 4. ما يجب فعله قبل النشر (يدوي)

### 4.1 Pre-flight قراءة فقط

نفّذ `supabase/verify_production_security.sql` كاملًا وسجّل المخرجات. لا تغيّر شيئًا. راجع خصوصًا:

- هل `products_public` موجود؟ ومن مالكه؟ وهل تعريفه يحتوي `active IS TRUE`؟
- هل توجد أي policy إضافية على `products` (ملكية/tenant) لا يطبّقها العرض؟
- هل `active IS TRUE` أكبر من صفر؟
- هل `anon` يقرأ العرض فقط، ولا يقرأ الجدول/الأعمدة؟
- هل `service_role` يحتفظ بـDML؟
- هل `users.session_version` موجود؟ (يحدد إن كان logout سيُبطل الجلسات)
- هل Storage bucket `products` مطابق (5MB + MIME)؟

### 4.2 ترتيب التنفيذ الإلزامي

1. **Pre-flight** أعلاه (قراءة فقط).
2. `supabase/atomic_place_order.sql`
3. `supabase/atomic_order_lifecycle.sql`
4. `supabase/admin_protection.sql`
5. `supabase/security_hardening.sql`
6. **انشر كود الكوبونات الجديد** ثم `supabase/coupons_lockdown.sql` (SECTION 0 → 1 → 2).
7. `supabase/session_revocation.sql` (آمن قبل/بعد النشر؛ الطرفان يبدآن بـ0).
8. `supabase/storage_hardening.sql` — راجع الـ NOTICE.
9. `supabase/products_public_view.sql` — **Phase 1 فقط** (ينشئ العرض، يمنح SELECT، يسجّل `products_public_phase1_applied`، ويتخطى Phase 3).
10. **انشر الواجهة والـ API الجديد** (يشمل `GET /api/admin/products`). تأكد من Network أن المتجر يقرأ `products_public`.
11. نفّذ فحوصات §5 (API + الإدارة + المتجر).
12. أدخل علم النشر **فقط بعد نجاح §5**:

```sql
INSERT INTO public.zshm_deploy_flags (name, note)
VALUES ('products_public_frontend_live', 'new bundle deployed')
ON CONFLICT (name) DO NOTHING;
```

13. أعد تشغيل `supabase/products_public_view.sql` — **Phase 3**.
14. أعد فحوصات §5 كاملة، ثم راجع Vercel logs وSupabase logs لمدة 24 ساعة.

**ممنوع:** إنشاء العلم قبل خطوة 10، أو تشغيل Phase 3 قبل التحقق من الشبكة.

### 4.3 إعدادات Vercel (لم تُنفَّذ)

- Project → Settings → Environment Variables، لكل من **Production** و**Preview**:
  - `UPSTASH_REDIS_REST_URL` (اختياري لكن موصى به)
  - `UPSTASH_REDIS_REST_TOKEN`
  - `TRACKING_TOKEN_TTL_HOURS` (اختياري؛ اتركه فارغًا للسلوك القديم)
- تأكد أن `SUPABASE_SERVICE_ROLE_KEY` و`SESSION_SECRET` سيرفر فقط، ولا توجد نسخة `VITE_`/`REACT_APP_` منهما.
- أعد النشر بعد أي تغيير.
- بعد النشر، راقب absence/presence رسالة `Durable rate limit unavailable, using per-instance fallback` في logs؛ غيابها يعني أن Upstash يعمل.

### 4.4 Supabase Dashboard (لم تُنفَّذ)

**Authentication:** إغلاق signups (أو مراجعة trigger)، تأكيد الإيميل، Site URL/Redirect allow-list، MFA للأدمن، 12+ كلمة مرور، Leaked Password Protection.

**Storage:** bucket `products` = public، 5MB، MIME (JPEG/PNG/WebP/GIF/AVIF). عند ظهور `MANUAL ACTION REQUIRED`: احذف سياسات `products` غير المحمية بالملكية فقط من Dashboard، **لا تغيّر ملكية `storage.objects` ولا تعطّل RLS**، ثم أعد تشغيل `storage_hardening.sql`.

---

## 5. التحقق الإنتاجي ومخرجات متوقعة (مرجع `security-production-checklist.md`)

نفّذ `supabase/verify_production_security.sql` وقارن:

| القسم | المتوقع بعد المرحلة المناسبة |
|---|---|
| 1. الملكية/النوع | `products_public` من نوع `v` (view)، مالكه `postgres` (أو دور موثوق ثابت)، `products` جدول. |
| 2. التعريف | يحتوي `WHERE (active IS TRUE)`؛ لا فلاتر إضافية مفقودة. |
| 3. الأعمدة | بالضبط: `id, name, category, price, salePrice, description, stock, variantStock, sku, label, colors, sizes, images, image, sizeGuide` — **بدون** `reservedStock` أو `tags` أو `rating` أو `reviews` أو `active`. |
| 4–6. الصلاحيات | بعد Phase 3: `anon/authenticated/PUBLIC` لا يقرأون `products` (جدولًا أو عمودًا)، و`anon` يقرأ `products_public`، و`service_role` يقرأ `products`. قبل Phase 3: `anon` قد يقرأ `products` (بالحزمة القديمة) — لا تعتبره فشلًا. |
| 7. RLS | `orders/users/coupons/zshm_deploy_flags/zshm_storage_policy_backup` = RLS مفعّل و0 policies (deny-all مقصود). لا تضف policies. |
| 8. العدّ | `active_products > 0`، و`total = active + inactive + null_active`، و`count(products_public) = active_products`. |
| 9. الأعلام | `products_public_phase1_applied` موجود بعد Phase 1؛ `products_public_frontend_live` **غير موجود** قبل النشر، وموجود فقط بعده. |
| 10. الجلسات | `users.session_version` موجود بعد `session_revocation.sql`. |
| 11. Storage | `products`: `public=true`، `file_size_limit=5242880`، MIME محددة. |
| 12. سياسات Storage | لا سياسات `products` غير محمية بالملكية؛ RLS مفعّل؛ الملكية دون تغيير. |
| 13. الوظائف | `search_path` مثبّت؛ `security definer` للوظائف المخصصة فقط. |
| 14. الفهارس | سجّل `idx_scan`؛ **لا تحذف أي index** قبل بيانات استخدام تمثيلية. |

**فحوصات API (بـ anon key من المتصفح/curl):**

- `GET /rest/v1/products_public` → 200، صفوف نشطة فقط، بلا `reservedStock`.
- `GET /rest/v1/products` → 401/403 **بعد Phase 3**.
- `GET /rest/v1/products?select=reservedStock` → 401/403 **بعد Phase 3**.
- `POST /api/orders` بمبالغ عميل مختلفة → السيرفر يتجاهلها ويعيد الحساب.

**فحوصات الإدارة (بعد النشر):**

- فتح Products: تظهر المنتجات المعطلة بشارة `INACTIVE`، وفتح منتج به `tags` والحفظ **لا يمسحها**.
- Dashboard → Inventory يشمل المنتجات غير النشطة عند دور لديه `products.read`.
- إنشاء/تعديل/حذف منتج يعمل؛ دور `support` لا يستطيع قراءة المنتجات الإدارية (403).
- تسجيل الخروج ثم إعادة استخدام الكوكي القديم → 401 (بعد تطبيق `session_revocation.sql`).

**فحوصات المتجر والجوال:**

- الرئيسية/`/shop`/صفحة منتج/صور/فلاتر/سلة/checkout/كوبون/طلب/رابط تتبع.
- عند قطع الشبكة أو 403: يظهر شريط خطأ + Retry لا «No Products Found».
- «Best Seller» يرتّب فعليًا.
- TrackOrder يوضّح الحاجة للرابط الآمن.
- 320/375/390/430 عرضًا، وConsole بلا أخطاء CSP/404 حرجة.
- المستخدمان الحاليان وأدوارهما دون تغيير.

---

## 6. SQL الجاهز وغير المُنفَّذ

كل الملفات التالية **مُعدّة للمراجعة اليدوية فقط**، ولم تُنفَّذ على أي بيئة:

- `supabase/atomic_place_order.sql`
- `supabase/atomic_order_lifecycle.sql`
- `supabase/admin_protection.sql`
- `supabase/security_hardening.sql`
- `supabase/coupons_lockdown.sql`
- `supabase/session_revocation.sql`
- `supabase/storage_hardening.sql`
- `supabase/products_public_view.sql` (Phase 1 ثم Phase 3)
- `supabase/verify_production_security.sql` (قراءة فقط)

**العلم الوحيد الذي يُدخَل يدويًا بعد النشر:**

```sql
INSERT INTO public.zshm_deploy_flags (name, note)
VALUES ('products_public_frontend_live', 'new bundle deployed')
ON CONFLICT (name) DO NOTHING;
```

**لا تُنفّذ:** أي `GRANT` على `products` لـ`anon/authenticated`، أو أي `ALTER TABLE ... OWNER`، أو تعطيل RLS، أو `DROP INDEX`.

---

## 7. التراجع (Rollback)

| ما تراجع عنه | الخطوة | ملاحظة |
|---|---|---|
| الواجهة | Vercel → Deployments → Promote الحزمة السابقة | الأفضل: أعد نشر الحزمة الجديدة بدل الرجوع القديمة. |
| Phase 3 | لا تراجع تلقائي | إن رجعت لحزمة قديمة تقرأ `products`، أعد `GRANT SELECT ON public.products TO anon, authenticated` **مؤقتًا للطوارئ فقط** (يعيد كشف `reservedStock`)، ثم أصلح فورًا وأعد Phase 3. |
| `products_public` | لا تحذفه أثناء وجود الحزمة الجديدة | Phase 1 إضافي وآمن. |
| `session_revocation.sql` | لا تحذف `users.session_version` | الكود يعمل بدونه، لكن الحذف يلغي إبطال الجلسات. |
| Storage | `SELECT public.zshm_restore_storage_policies();` من دور يدير `storage.objects` | لا تغيّر الملكية ولا تعطّل RLS. |
| Upstash | إزالة المتغيرين وإعادة النشر | يعود fallback لكل نسخة، وليس تعطيلًا كاملًا. |
| توكن التتبع | إزالة `TRACKING_TOKEN_TTL_HOURS` | الروابط القديمة تبقى صالحة. تدوير `SESSION_SECRET` يُبطل كل الروابط. |

---

## 8. ما بقي محجوبًا أو يحتاج قرارًا

1. **F-13:** اختبار المتصفح المحلي للمسارات الأساسية والمقاسات تم؛ ما زال يلزم Preview أو staging لفحص Console/Network/CSP وE2E.
2. **S-13 / H-03:** إثبات أن العرض لا يتجاوز RLS الحقيقي يحتاج `pg_policies` من الإنتاج.
3. **O-12 / L-10 (SEC-24):** `reservedStock` بلا كاتب/دورة حياة. القرار المطلوب: إزالته من حساب التوفر والجداول، أو إضافة كاتب ودورة حياة موثقة. لم يُخترع أي كاتب.
4. **O-11 / M-02:** حذف طلب به منتج محذوف نهائيًا قد يمنع استعادة مخزون السطور الأخرى. القرار: منع حذف المنتج المرتبط بطلبات غير ملغاة، أو استعادة جزئية + تقرير فروقات إلزامي.
5. **S-01 / S-05:** `security_invoker=false` وRLS deny-all قرارات مقصودة؛ لا تُغيَّر.
6. **S-12 / M-04:** إعدادات Supabase Auth يدوية بالكامل.
7. **الفهارس:** لا حذف قبل `pg_stat_user_indexes`.
8. **CI:** الملف جاهز لكنه لا يعمل حتى `commit`/`push`، ولم يُنفَّذا.

---

## 9. معايير تحويل الحكم إلى Go

- [ ] `npm test` = 0 failed و`npm run build` PASS (منفّذ محليًا: 817/817 + PASS).
- [ ] Pre-flight و`verify_production_security.sql` مطابقان للمتوقع في §5.
- [ ] كل ملفات SQL طُبّقت بالترتيب، وPhase 3 نُفّذ بعد النشر والتحقق الشبكي فقط.
- [ ] `anon` لا يقرأ `products` ولا `reservedStock`، ويقرأ `products_public` فقط.
- [ ] لوحة المنتجات تُظهر غير النشط، و`tags` لا تُمسح عند الحفظ.
- [ ] سيناريو شراء كامل + إلغاء طلب + استعادة مخزون + تتبع + إدارة منتجات ناجح.
- [ ] لا أخطاء Console/CSP حرجة على Preview/Production، والجوال سليم.
- [ ] المستخدمان الحاليان وأدوارهما دون تغيير.
- [ ] أي بند «Accepted Risk» موثّق ومقبول صراحةً من صاحب المنتج.

عندها فقط يمكن تغيير الحكم من **Conditional Go** إلى **Go**.

---

## 10. 追加更新 (2026-11-01 follow-up pass)

- Floating buttons remain fixed on the storefront at z-index 30000 with
  safe-area offsets. WhatsApp stays visible; scroll-to-top appears after
  scrolling beyond 300px and hides near the top.
- `/sitemap.xml` is dynamically generated from the public `products_public`
  view using anon credentials; `/` and `/shop` remain included. Verify the
  route after deployment and set `PUBLIC_BASE_URL` if the canonical domain differs
  from the configured default. Empty checkout exposes its empty-state message as an H1.
- `pageUrl('track')` preserves `track` and `tk` query params.
- `updateCartQty` returns `{ success, error }`; callers toast stock limits.
- Product image cursor set to `default`.
- Admin a11y gaps fixed (labels, dialogs, drop zones, toggles).
- `api/_lib.js` mask comment corrected.
- Latest verification: `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → **918 passed, 0 failed**
  (SQL suite actually ran). `npm run build` → success. `npm audit` → 0
  vulnerabilities. No configured server-only secret values were found in `build/`.
