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
| `ZSHM_REQUIRE_SQL_TESTS=1 npm test` | **922 passed, 0 failed** — 10 مجموعات: 81 + 90 + 80 + 79 + 74 + 18 + 97 + 126 + 29 + 248 |
| `node scripts/test-admin-products.mjs` | **18 passed, 0 failed** |
| `node scripts/test-sessions-admin.mjs` | **74 passed, 0 failed** |
| `node scripts/test-edge-transport.mjs` | **97 passed, 0 failed** |
| `node scripts/test-final-hardening.mjs` | **126 passed, 0 failed** |
| `node scripts/test-sitemap.mjs` | **29 passed, 0 failed** |
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
2. `supabase/atomic_place_order.sql` (REVISION 10 — رفض المقاس/اللون غير المعرّف، رفض الإعداد غير الصالح `invalid_product_config`، وإعادة حساب `stock` من التركيبات المعرفة فقط. وإن كان الإصدار السابق مطبَّقًا فيكفي التدرّج: `supabase/reject_undefined_variants.sql` ثم `supabase/declared_only_stock_recompute.sql` بالترتيب).
3. `supabase/atomic_order_lifecycle.sql`
4. `supabase/atomic_edit_order.sql` — بعد lifecycle لأنه يستخدم `atomic_adjust_stock` و`zshm_order_items()`/`zshm_order_lines()`/`zshm_adjust_coupon_usage()`. يضيف تعديل الطلب (بيانات العميل/المنتجات/الكوبون) داخل transaction واحد مع `timestamps.rev` وفرق مخزون صافٍ. **انشر الـAPI والواجهة الجديدة بعده** حتى يعمل زر تعديل الطلب.
5. `supabase/admin_protection.sql`
6. `supabase/security_hardening.sql`
7. **انشر كود الكوبونات الجديد** ثم `supabase/coupons_lockdown.sql` (SECTION 0 → 1 → 2).
8. `supabase/session_revocation.sql` (آمن قبل/بعد النشر؛ الطرفان يبدآن بـ0).
9. `supabase/storage_hardening.sql` — راجع الـ NOTICE.
10. `supabase/products_public_view.sql` — **Phase 1 فقط** (ينشئ العرض، يمنح SELECT، يسجّل `products_public_phase1_applied`، ويتخطى Phase 3).
11. **انشر الواجهة والـ API الجديد** (يشمل `GET /api/admin/products` و`PATCH /api/admin/orders` بوضع `action: 'edit'`). تأكد من Network أن المتجر يقرأ `products_public`.
12. نفّذ فحوصات §5 (API + الإدارة + المتجر).
13. أدخل علم النشر **فقط بعد نجاح §5**:

```sql
INSERT INTO public.zshm_deploy_flags (name, note)
VALUES ('products_public_frontend_live', 'new bundle deployed')
ON CONFLICT (name) DO NOTHING;
```

14. أعد تشغيل `supabase/products_public_view.sql` — **Phase 3**.
15. أعد فحوصات §5 كاملة، ثم راجع Vercel logs وSupabase logs لمدة 24 ساعة.
16. `supabase/stock_hardening_constraints.sql` — **الخطوة الأخيرة، اختيارية لكن موصى بها**: قيود `NOT NULL` و`CHECK` على الأعمدة الحقيقية `"reservedStock"` و`"variantStock"` (باقتباس صحيح) داخل transaction واحد مع `lock_timeout` وفشل مغلق إن وُجدت صفوف NULL/غير صالحة. لا يعدّل أي بيانات: يعرض التقرير في §0 ثم يوقف التنفيذ إن لزم. للتراجع نفّذ `supabase/stock_hardening_constraints_rollback.sql` كما هو. أعد الفحص الثاني (تشغيل الملف مرتين) آمن لأن كل قيد محمي بفحص كتالوج.

**ممنوع:** إنشاء العلم قبل خطوة 11، أو تشغيل Phase 3 قبل التحقق من الشبكة.

> **حالة الإنتاج (تحقق 2026-11-07):** المشروع `ptegprcbtfylqhbnbkih` كان يحتوي
> الخطوات 1، 2، 5، 6، 7 (`Phase 1` و`Phase 3`) و`coupons_lockdown` و`session_revocation`
> و`rate_limit_storage` و`stock_hardening_constraints` مطبّقة بالفعل. طُبّقت الخطوة 3
> (`supabase/atomic_edit_order.sql`) في 2026-11-07 بعد نسخ الحالة السابقة (الدالة لم تكن
> موجودة)، وتحقّق أنها `SECURITY INVOKER` مع `search_path` مثبّت، وأن `anon`/`authenticated`
> لا يملكان EXECUTE بينما `service_role` يملكه، وأن عدّد الصفوف لم يتغير (15 طلبًا، منتج
> واحد، مستخدمان، كوبون واحد). نُشر الكود `2598e32` على
> `zashm-2jtixyf86-zashm.vercel.app` ويعمل على https://za-shm.vercel.app.

### 4.3 إعدادات Vercel (لم تُنفَّذ)

- Project → Settings → Environment Variables، لكل من **Production** و**Preview**:
  - `UPSTASH_REDIS_REST_URL` و`UPSTASH_REDIS_REST_TOKEN` (اختياريان؛ عند غيابهما يستخدم الكود RPC قاعدة البيانات بعد تطبيق migration `supabase/rate_limit_storage.sql`).
  - `TRACKING_TOKEN_TTL_HOURS` (اختياري؛ الافتراضي للروابط الجديدة 720 ساعة/30 يومًا).
- تأكد أن `SUPABASE_SERVICE_ROLE_KEY` و`SESSION_SECRET` سيرفر فقط، ولا توجد نسخة `VITE_`/`REACT_APP_` منهما.
- أعد النشر بعد أي تغيير.
- طبّق migration الـRPC قبل الاعتماد على fallback قاعدة البيانات. ظهور `Shared rate limit unavailable` في logs يعني أن Upstash وRPC غير متاحين وأن الحماية تراجعت إلى عدادات لكل نسخة.

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
| 3. الأعمدة | بالضبط: `id, name, category, price, salePrice, description, stock, variantStock, sku, label, colors, sizes, images, image, sizeGuide, rating, reviews` — **بدون** `reservedStock` أو `tags` أو `active`. (`rating`/`reviews` مجاميع المراجعات المعتمدة فقط، تعرضها كروت المنتجات.) |
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

- `supabase/atomic_place_order.sql` — REVISION 10.
- `supabase/reject_undefined_variants.sql` — Migration 1 من 2 (لم يُطبَّق): يضيف `public.zshm_sellable_stock()` ويستبدل `atomic_place_order` برفض المقاس/اللون غير المعرّف (`undefined_variant`) ورفض variantStock بلا sizes/colors معرفة (`invalid_product_config`) وكتابة `stock` من التركيبات المعرفة فقط. نفس نص الدوال حرفيًا في الملف المرجعي، و`scripts/test-undefined-variant.mjs` يقارنهما، و`[9]` في `scripts/test-sql-concurrency.mjs` يطبّق الملف على PostgreSQL حقيقي مؤقت. الفحص 0c هو جرد المنتجات القديمة (كانت صفر وقت المراجعة) — إن رجعت أي صفوف فتوقف وراجع القائمة قبل التطبيق. لا يحذف ولا يصفّر أي مخزون ولا يمسّ الطلبات القائمة.
- `supabase/declared_only_stock_recompute.sql` — Migration 2 من 2 (لم يُطبَّق، بعده مباشرة): يستبدل `atomic_adjust_stock` بنفس قاعدة إعادة الحساب حتى لا يتناقض الإلغاء/الاسترجاع مع الشراء. يفشل loudly إن لم يكن Migration 1 مطبَّقًا. لا يغيّر أي صف منتج عند التطبيق؛ الأرقام تتحرك فقط مع أول عملية دورة حياة حقيقية.
- `supabase/atomic_order_lifecycle.sql`
- `supabase/atomic_edit_order.sql` — تعديل الطلب من لوحة الإدارة (بيانات العميل/المنتجات/الكوبون) داخل transaction واحد: قفل الطلب أولًا، فحص `timestamps.rev`، فرق مخزون صافٍ (خصم صارم ثم استرجاع متسامح)، وإعادة التحقق من الكوبون ونقل عدّاد الاستخدام مرة واحدة. المنتجات قابلة للتعديل في `Pending`/`Confirmed` فقط، وبيانات العميل دائمًا. لا يغيّر حالة الطلب ولا يحذف شيئًا.
- `supabase/admin_protection.sql`
- `supabase/security_hardening.sql`
- `supabase/coupons_lockdown.sql`
- `supabase/session_revocation.sql`
- `supabase/storage_hardening.sql`
- `supabase/products_public_view.sql` (Phase 1 ثم Phase 3)
- `supabase/remove_legacy_products_read_policy.sql` — تنظيف بعد Phase 3 فقط: يحذف سياسة `public_read_products` القديمة (`PERMISSIVE SELECT` لـ anon/authenticated بـ `USING true`) من الجدول الأساسي `products`. كانت عديمة الأثر بعد سحب الـ grants، لكنها كشف ضمني لو رُجّع منح `SELECT`. **مطبَّق على الإنتاج في 2026-11-20** بموافقة المالك؛ التحقق: `legacy_policy_rows=0`، anon/auth لا يقرآن `products`، anon يقرأ `products_public`، وservice_role يقرأ `products`. الملف idempotent ويفشل مغلقًا إن وُجد منح متصفح للجدول الأساسي؛ التراجع موثّق بداخله ولا يُستخدم إلا مع إلغاء Phase 3.
- `supabase/product_reviews.sql` — تقييمات المنتجات: ينشئ `public.product_reviews` (service-role فقط)، وtrigger يحدّث `products.rating`/`products.reviews` من المراجعات المعتمدة فقط، ويعيد إنشاء `products_public` بنفس قائمة السماح مع `rating`/`reviews` في آخر الأعمدة. **مطبَّق على الإنتاج في 2026-11-07 ومنشور مع commit `6b7f339`** بعد التحقق بالـ anon key أن `rating`/`reviews` ظاهرة و`reservedStock` مخفي وأن الجدول service-role فقط. لو أُعيد تشغيل Phase 1 من `products_public_view.sql` لاحقًا فيجب إعادة تطبيقه. التقييمات الجديدة تبدأ `pending` ولا تظهر للعملاء قبل الموافقة من لوحة الإدارة.
- `supabase/product_size_ranges.sql` — نوافذ المقاسات **مطبَّق على الإنتاج في 2026-11-13**: يضيف `public.products."sizeRanges" jsonb NOT NULL DEFAULT '{}'` (لكل مقاس: min/max وزن و min/max طول) ويعيد إنشاء `products_public` بقائمة السماح نفسها مع `sizeRanges`. أداة «اعرف مقاسك» في المتجر تقرأ هذه النوافذ؛ قبل التطبيق كانت تعمل على جدول المقاسات القياسي فقط، وكان حفظ المنتج من الإدارة يُرجع `warnings.sizeRanges = 'column-missing'` بدل الادعاء بأن النوافذ حُفظت. **تم التحقق بعد التطبيق**: العمود `jsonb NOT NULL DEFAULT '{}'`، والقيد `products_sizeRanges_object_chk` موجود، وكل المنتجات الحالية عُبّئت بـ `{}`، و`products_public` تُظهر `sizeRanges` وتخفي `reservedStock`، و`anon` يقرأ العرض ولا يقرأ الجدول الأساسي، وقراءة PostgREST تعمل بعد إعادة تحميل الـ schema cache. النسخة الاحتياطية قبل التطبيق في `backups/2026-11-13T11-07-36Z-size-ranges-pre-apply/`. **يُطبَّق بعد `products_public_view.sql` و`product_reviews.sql`**؛ الملفان الآخران يبنيان العرض من تقاطع قائمة السماح مع الأعمدة الموجودة، لذا إعادة تشغيلهما بعد هذا الملف لا تحذف `sizeRanges`. الملف idempotent (اسم القيد بين علامات اقتباس + `IF NOT EXISTS`) ويفشل مغلقًا إن دخل `reservedStock` قائمة السماح. التراجع يحذف العمود ويفقد كل النوافذ المُدخلة نهائيًا — خُذ نسخة احتياطية أولًا.
- `supabase/product_review_photos.sql` — صورة اختيارية مع تعليق العميل: يضيف `public.product_reviews."photoPath" text` (مسار قصير فقط، والبايتات في bucket `products` تحت `reviews/<productId>/`) مع قيد `product_reviews_photo_path_len` يرفض المسارات المطلقة أو التي تحتوي `..`. **مطبَّق على الإنتاج في 2026-11-16** عبر `supabase db query --linked --file supabase/product_review_photos.sql` بعد `product_reviews.sql`؛ تم التحقق بعده أن قراءة service-role للأعمدة `id,"photoPath"` تُرجع الصفوف الحالية بـ`photoPath: null`، وأن القيد موجود بالتعريف المتوقع (NULL أو 10–300 حرفًا، بلا `/` بادئة وبلا `..`). الملف idempotent (`ADD COLUMN IF NOT EXISTS` + قيد محمي) ولا يعدّل أي صف موجود. الكود آمن لو غاب العمود: `/api/reviews` يفحصه ويُرجع `photosEnabled:false` فلا تظهر خانة الصورة، وأي إرسال بصورة يُحفظ التعليق بدونها (`photoSaved:false`)؛ والنتيجة السلبية تُعاد قراءتها بعد 60 ثانية كي تلتقط النسخة الساخنة الترحيل المتأخر، ولا تُحفظ أخطاء الفحص العابرة. التراجع يحذف العمود ويفقد المسارات فقط، وملفات الصور تبقى في الـbucket ويمكن حذفها يدويًا.
- `supabase/rate_limit_storage.sql` (shared rate-limit fallback)
- `supabase/stock_hardening_constraints.sql` — قيود NOT NULL/CHECK (لم يُطبَّق): يصحّح أسماء الأعمدة الحساسة لحالة الأحرف (`"reservedStock"` و`"variantStock"`) داخل transaction واحد مع `lock_timeout = 5s`، ويفشل مغلقًا قبل إضافة أي قيد إن وُجدت قيم NULL أو سالبة أو مفاتيح variantStock غير صالحة، ولا يحذف/يصفّر أي مخزون. كل قيد يُضاف مرة واحدة فقط (فحص `pg_constraint`) لذا إعادة التشغيل آمنة. التراجع: `supabase/stock_hardening_constraints_rollback.sql` (قابل للتنفيذ كما هو).
- `supabase/stock_hardening_constraints_rollback.sql` (rollback للقيود فقط؛ لا يمسّ البيانات)
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
| توكن التتبع | إزالة `TRACKING_TOKEN_TTL_HOURS` | الروابط الجديدة تعود إلى مهلة 720 ساعة؛ الروابط القديمة تبقى صالحة. تدوير `SESSION_SECRET` يُبطل كل الروابط. |

---

## 8. ما بقي محجوبًا أو يحتاج قرارًا

1. **F-13:** اختبار المتصفح المحلي للمسارات الأساسية والمقاسات تم؛ ما زال يلزم Preview أو staging لفحص Console/Network/CSP وE2E.
2. **S-13 / H-03:** إثبات أن العرض لا يتجاوز RLS الحقيقي يحتاج `pg_policies` من الإنتاج.
3. **SEC-24 / O-12 / L-10:** `reservedStock` مستبعد من حساب التوفر في الكود وRevision 8 من migration الطلبات؛ Production state غير متحقق. أبقِ العمود دون كاتب أو lifecycle.
4. **O-11 / M-02:** المعالجات المحلية تستعيد مخزون كل المنتجات الموجودة وتتجاوز المفقود مع تحذير؛ يلزم التحقق من تطبيق migration Revision 3 على Production.
5. **S-01 / S-05:** `security_invoker=false` وRLS deny-all قرارات مقصودة؛ لا تُغيَّر.
6. **S-12 / M-04:** إعدادات Supabase Auth يدوية بالكامل.
7. **الفهارس:** لا حذف قبل `pg_stat_user_indexes`.
8. **CI:** الملف جاهز لكنه لا يعمل حتى `commit`/`push`، ولم يُنفَّذا.

---

## 9. معايير تحويل الحكم إلى Go

- [ ] `npm test` = 0 failed و`npm run build` PASS (آخر تحقق محلي موثق: 968/968 + PASS).
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
  route after deployment and ensure `PUBLIC_BASE_URL` matches the approved
  canonical origin. Empty checkout exposes its empty-state message as an H1.
- `pageUrl('track')` preserves `track` and `tk` query params.
- `updateCartQty` returns `{ success, error }`; callers toast stock limits.
- Product image cursor set to `default`.
- Admin a11y gaps fixed (labels, dialogs, drop zones, toggles).
- `api/_lib.js` mask comment corrected.
- Latest verification: `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → **922 passed, 0 failed**
  (SQL suite actually ran). `npm run build` → success. `npm audit` → 0
  vulnerabilities. No configured server-only secret values were found in `build/`.

## 11. Checkout and shared-rate-limit follow-up (local only)

- Checkout reuses a cryptographically random, storage-persisted idempotency key
  for retries; the API rejects requests without a valid key. Checkout also
  states bilingually that payment is cash on delivery and no online payment is
  collected.
- Coupon creation always starts `usageCount` at zero; updates cannot change
  this server-maintained counter.
- Rate limiting uses Upstash when configured, falls back to the server-only
  `zshm_rate_limit` Supabase RPC, then to bounded per-instance counters. The
  additive `supabase/rate_limit_storage.sql` is not applied to any environment;
  without it or healthy Upstash, limits remain per-instance.
- `storage_hardening.sql` now creates a restrictive browser SELECT policy to
  prevent listing product object names when the migration executor can manage
  `storage.objects`; otherwise it reports the required Dashboard action.
- `reservedStock` remains deliberately unused. The revised atomic order
  migration must be applied on Production for this invariant to hold there.
- Latest local verification: `ZSHM_REQUIRE_SQL_TESTS=1 npm test` →
  **968 passed, 0 failed** (temporary PostgreSQL 17 suite ran);
  `npm run build` → success; `npm audit --omit=dev` → **0 vulnerabilities**.
  The build contained no server-only environment variable names.
- This follow-up changed or added: `.env.example`, `api/_lib.js`,
  `api/admin/coupons.js`, `api/orders.js`, `docs/production-remediation-handoff.md`,
  `docs/security-production-checklist.md`, `package.json`,
  `scripts/test-checkout-idempotency.mjs`, `scripts/test-coupons.mjs`,
  `scripts/test-edge-transport.mjs`, `scripts/test-final-hardening.mjs`,
  `scripts/test-order-pricing.mjs`, `scripts/test-sql-concurrency.mjs`,
  `src/lib/orderIdempotency.mjs`, `src/pages/CartPage.js`,
  `supabase/rate_limit_storage.sql`, `supabase/storage_hardening.sql`, and
  `supabase/verify_production_security.sql`.
- No migrations, Vercel/Supabase settings, production data, deployment, or Git
  history were changed. Auth, Storage, migration and deployment state remains
  NOT VERIFIED; production launch is blocked until the documented rollout and
  live verification are completed.

## 12. Real 404 status for unknown paths (2026-11-02, local only)

- **Root cause:** the Vercel project was created with the **Create React App**
  framework preset (`vercel project inspect zashm`). That preset appends
  `{ "src": "/(.*)", "dest": "/index.html" }` to the build output *after*
  `vercel.json` is applied, so every unknown path returned `HTTP 200` with the
  SPA shell even though `vercel.json` has no catch-all rewrite. The route is not
  visible in `vercel.json`, only in `.vercel/output/config.json`.
- **Fix:** `vercel.json` now pins `"framework": null` ("Other" preset). The
  build output no longer contains the catch-all and keeps Vercel's own
  `{ "status": 404, "dest": "/404.html" }` route. `public/404.html` (already
  shipped) was rewritten as a small bilingual page with Home/Shop links; it is
  copied to `build/404.html` and served with status `404` and `noindex`.
- **Unchanged:** explicit SPA rewrites (`/shop`, `/cart`, `/checkout`,
  `/wishlist`, `/track`, `/admin`, `/product/:path*`), the trailing-slash 308
  redirect, all CSP/security headers, and `/api/*` routing — verified by
  diffing the pre/post `.vercel/output/config.json`.
- **Local verification:** `vercel build --yes` → no `/(.*) → /index.html`
  route, `{ "status": 404, "src": "^(?!/api).*$", "dest": "/404.html" }`
  present, `404.html` present in the static output; `npm test` → 1,023 passed,
  0 failed (temporary PostgreSQL 17 suite ran); `npm run build` → success.
- **Post-deploy verification (performed 2026-11-02, deployment
  `zashm-i7mzkf7f0-zashm.vercel.app` → production `https://za-shm.vercel.app`):**
  `/definitely-not-a-page`, `/random/deep/path`, `/assets/missing-abc123.js` and
  `/product-not-real` → **404** with the bilingual page (meta `noindex`,
  CSP/HSTS/X-Frame-Options still applied); `/`, `/shop`, `/cart`, `/checkout`,
  `/track`, `/wishlist`, `/admin`, `/product/1793586156664926`, `/404.html`,
  `/sitemap.xml` and `/robots.txt` → **200**; `/shop/` → **308** `/shop`;
  `/api/admin/orders` → 401, `POST /api/coupons/validate` → 400,
  `OPTIONS /api/coupons/validate` → 204 with the allow-listed origin only,
  `POST /api/orders {}` → 422. Deployed asset filenames are byte-identical to
  the local `build/`. The static 404 page renders without loading React and its
  Home/Shop links work.
- Do not remove `"framework": null` and do not switch the dashboard preset back
  to Create React App/Vite without re-checking that the soft 404 does not
  return.
- The deployment was made from the uncommitted working tree with explicit owner
  approval; the changes are **not committed** yet.

## 13. Product 404 middleware, dev-server fix, badge/copy polish (2026-11-02, local only)

### 13.1 Product soft-404 (crawler-facing real 404)

- **Problem:** `/product/<unknown-id>` still answered `200` with the SPA shell.
  The generic `404.html` route cannot know which product ids exist, so section 12
  only fixed unknown *paths*, not unknown *products*.
- **Fix:** root `middleware.ts` (Vercel Routing Middleware, `config.matcher =
  ['/product/:path*']`, `runtime: 'nodejs'` — the default edge runtime is
  deprecated). For product-detail URLs it validates the id shape, then
  checks `products_public` with the anon key, and returns a real `404` that
  reuses the shipped `public/404.html`, plus `x-robots-tag: noindex, nofollow`.
- **Crawler-gated by design:** the DB check only runs for crawler user agents
  (`Googlebot`, `Google-InspectionTool`, `bingbot`, link-preview bots, etc.).
  Shoppers keep the instant static shell, no extra round trip, and no storefront
  regression if the check is slow.
- **Fail-open contract** (`src/lib/product-exists.cjs`): `true` = exists,
  `false` = missing/malformed id, `null` = unknown (no config, timeout, non-2xx,
  bad payload). Only `false` produces a 404, so a Supabase outage can never hide
  a real product or break sharing links. The lookup timeout is 8s: local round
  trips measured 0.2–4.7s with spikes past 5s, and a shorter cap produced
  intermittent fail-open `200`s.
- **Module format (production incident, 2026-11-03):** the first deployment of
  this middleware answered `500 MIDDLEWARE_INVOCATION_FAILED` on every
  `/product/*` URL. Vercel compiles `middleware.ts` to CommonJS, but the helper
  was shipped as an ES module, so `require()` crashed with `ERR_REQUIRE_ESM`
  (confirmed in the deployment logs). The helper is now
  `src/lib/product-exists.cjs` (CommonJS) and the built function only does
  `require("./src/lib/product-exists.cjs")`. The deployment was reverted by
  redeploying a corrected build; `vercel rollback` was rejected by the plan
  ("upgrade to Pro"), so rollback must happen through a redeploy.
- **Pre-deploy artifact check:** `vercel build --yes`, then
  `require('.vercel/output/functions/middleware.func/middleware.js')` and call
  `default(request)`: real id + Googlebot → 200 + `x-middleware-next: 1`;
  `999999999` / `abc` / `0` + Googlebot → 404 with `x-robots-tag`; Chrome UA →
  200 + continuation. This tests the exact artifact Vercel runs, which
  `vercel dev` does not.
- **Continuation:** the Node.js runtime drops the body when the middleware
  returns `undefined`, so every pass-through returns `new Response(null, {
  headers: { 'x-middleware-next': '1' } })`. That is byte-for-byte what `next()`
  from `@vercel/functions` does; the helper is inlined to avoid adding a runtime
  dependency (installing the package pulled 4 high `npm audit` findings through
  `@vercel/oidc`/`zod`).
- **Client-side honesty:** `ProductPage` now sets `robots: noindex, nofollow` and
  removes the canonical (`clearCanonical()`) for the not-found state.
- **Do not move the matcher into `vercel.json`:** `proxy.matcher` conflicts with
  `config.matcher` (`vercel dev` reports "configure the matcher in only one
  location"). Keep `middleware.ts` as the single source.
- **Local verification (`vercel dev --listen 3005`, Node.js runtime):**
  - existing product + Googlebot → `200` (no false 404), 3/3;
  - `999999999` + Googlebot → `404` with the bilingual page and
    `x-robots-tag: noindex, nofollow`, 10/10 after the timeout bump
    (before it, slow Supabase round trips occasionally failed open to `200`);
  - `999999999` + Bingbot → `404`; `abc` / `0` + Googlebot → `404`;
  - link-preview bot (`facebookexternalhit`) on the real product → `200`;
  - normal Chrome UA → `200` (SPA not-found view, `noindex` in the head);
  - `/`, `/shop`, `/product`, `/cart`, `/checkout`, `/wishlist`, `/track`,
    `/admin`, `/404.html`, `/robots.txt` → `200`; `/api/auth` → `405`;
    `OPTIONS /api/coupons/validate` → `204`; `/api/admin/orders` → `401`;
  - `vercel build --yes` → `middleware.func` emitted, output route
    `{ middlewares: [{ middlewarePath: "middleware", continue: true,
    override: true }] }` for `/product/:path*`, `/product` → `/index.html`,
    `{ status: 404, dest: /404.html }` retained, `404.html` in static output.
- **Not verified locally:** Routing Middleware responses do not carry the
  `vercel.json` CSP/HSTS headers in the local proxy. Confirm on the deployment.

### 13.2 `vercel dev` recursion / port detection

- **Root cause:** `package.json` had `"dev": "vercel dev"`, so `vercel dev` tried
  to invoke itself (`DEV_RECURSIVE_INVOCATION`). Separately, a fixed
  `--port 3000` made it wait for a port the proxy never received
  (`DEV_PORT_DETECTION_TIMED_OUT`).
- **Fix:** `start`/`dev` are plain `vite`; `vite.config.js` reads
  `process.env.PORT` with a `3000` fallback and `strictPort: true`;
  `vercel.json` sets `"devCommand": "npm run start"`.
- **Verified:** `vercel dev --listen 3005` becomes ready; `/`, `/shop` → 200,
  `/api/auth` → 405, `OPTIONS /api/coupons/validate` → 204,
  `/api/admin/orders` → 401.

### 13.3 Cart/wishlist badge proximity

- **Problem:** badges were positioned against the 42px hit area, so they floated
  ~13–19px away from the 20px glyph and the wishlist/bag offsets differed.
- **Fix:** each header icon is wrapped in a 20px `position: relative` box
  (`iconWrapStyle`); both badges share `top: -5, right: -6`. The bottom-nav badge
  uses the same icon-anchored box with `top: -5, right: -5`. Counts are announced
  through `aria-label` ("Wishlist, 1 item" / "Shopping bag, 2 items"); the visual
  number is `aria-hidden` so it is not read twice.
- **Browser measurement (816×755, local):** both badges now overhang the icon by
  exactly 6px right / 5px top (previously wishlist 0/13 and bag 8/9).
- **Not verified:** real 320/375/768px emulation is unavailable in this
  environment; the bottom-nav badge was verified from computed inline styles and
  geometry only.

### 13.4 Governorate suggestions

`CartPage` renders `Cairo · القاهرة`: an explicit `{" · "}` separator (hidden
from screen readers) and `<span lang="ar" dir="rtl">` around the Arabic name.
Browser check at 816px: `innerText` is `Cairo · القاهرة`, `lang="ar"`,
`dir="rtl"`, no horizontal overflow.

### 13.5 Tests and build (local)

- `npm test` → **1,100 passed, 0 failed across 14 suites**; the SQL suite ran
  against a temporary PostgreSQL 17 cluster (no production connection).
  New `scripts/test-routing.mjs` → **63 passed** (crawler/id parsing, the
  true/false/null lookup contract, the 404 response, continuation, middleware +
  dev wiring).
  `scripts/test-final-hardening.mjs` → **165 passed** (section [12] badge,
  governorate and noindex assertions); `scripts/test-edge-transport.mjs` →
  **109 passed**.
- `npm run build` → success; `vercel build --yes` → success with middleware;
  `npm audit --omit=dev` → **0 vulnerabilities** (no dependency added).

### 13.6 Post-deploy verification (NOT performed for these changes)

1. Deploy only after owner approval; these changes are uncommitted.
2. `curl -A Googlebot https://za-shm.vercel.app/product/1793586156664926` → 200;
   `.../product/999999999` and `.../product/abc` → 404 with the bilingual page.
3. Confirm the middleware 404 carries CSP/HSTS/X-Frame-Options and
   `x-robots-tag: noindex, nofollow`.
4. Normal browser UA on a missing product still renders the SPA not-found view
   with `<meta name="robots" content="noindex, nofollow">` and no canonical.
5. Re-check header badges at 320/375/768/1440px and the bottom-nav badge at
   320/375px; WhatsApp and scroll-to-top stay visible above every layer.
6. If Routing Middleware is disabled or fails to build on the Vercel plan,
   `vercel build`/deploy output must be checked before assuming the product 404
   is live.

### 13.7 Admin image uploads: payload budget (2026-11-03, local only)

- **Symptom:** product images and size charts took a very long time and mostly
  ended in `Network error — could not reach the server` / `خطأ في الشبكة`.
- **Root cause:** the upload is a **base64 JSON** body (`{ file: 'data:…' }`).
  The client allowed a 3.5MB data URL (≈4.7MB body after JSON), which crosses
  Vercel's ~4.5MB request cap; the platform answers `413
  FUNCTION_PAYLOAD_TOO_LARGE` **before** the function runs, so the SPA never
  sees a JSON error. Measured from this network: a 4.5MB body → `413` after
  ~109–120s; a 1.4MB body → 24s. Two uploads ran in parallel, doubling the
  contention on a mobile uplink, so slow links dropped the connection first and
  surfaced as a generic network error.
- **Fix (client only, server contract unchanged):**
  - `src/components/admin/ImageUploader.js`: source files up to **15MB** are
    accepted and compressed on the canvas to **≤900KB** (WebP 0.82 at 1600px,
    with 1280/1024px JPEG fallbacks), so the data URL stays ≤**1.35MB** and the
    JSON body under ~1.4MB — a third of the platform cap.
  - uploads are **sequential** (`MAX_PARALLEL_UPLOADS = 1`) with one retry on
    status `0`/`408`/`502`/`503`/`504` and a visible `Uploading X of Y…`
    counter.
  - `413` keeps its own message ("Image is too large for the server"), so a size
    problem is never reported as a network failure.
- **Server side (unchanged):** `api/admin/upload.js` still caps the body at 4MB,
  decoded bytes at 3MB, and validates magic bytes; the Supabase bucket stays at
  5MB with a MIME allow-list. No limit was weakened.
- **Tests:** `scripts/test-final-hardening.mjs` section [13] parses the client
  constants and asserts the prepared body stays under 1.5MB and inside the
  server `MAX_BODY`, plus sequential upload, retry predicate and progress copy.
- **Measured payloads (from this network, unauthenticated → `401`):** the old
  3.5MB data URL produced a ~4.7MB body; a 4.5MB body → `413
  FUNCTION_PAYLOAD_TOO_LARGE` after 109–120s. The new 1.35MB data URL (1.41MB
  body) is accepted and answered in ~13.5s with no platform rejection.
- **Measured compression (Chrome, 4000×3000 source):** a gradient/typography
  image → 14KB WebP at 1600px; worst-case random noise → 1084KB at 1600px, then
  473KB JPEG at 1280px (631KB data URL). Both stay inside the budget.
- **Not verified:** the end-to-end upload could not be exercised because no
  admin session was available in this environment; the conclusion comes from the
  measured platform responses above and the code path, not a live upload.



### 13.8 Outage resilience: catalogue snapshot, same-origin image mirror, WhatsApp fallback (2026-11-07, local only)

**Status (2026-11-07): implemented, committed (ae6deea), pushed, and deployed to
production (https://za-shm.vercel.app serves /assets/index-HD5wpGoL.css and
the empty backup at /catalog-snapshot.json).** No external account, credential,
credit card, or environment variable is involved.

No external account, credential, credit card, or environment variable is needed.
See `docs/security-production-checklist.md §4b` for the routine and verification
checklist.

- **Catalogue:** `src/store.js` still prefers `products_public`; on a
  network/5xx/empty failure it falls back to the same-origin
  `public/catalog-snapshot.json`, records `productsSource: 'snapshot'` and
  `productsDegraded: true`, and keeps the last persisted copy if the snapshot is
  missing too. `src/components/ui/OutageNotice.js` renders an inline backup
  banner with a WhatsApp action; it is never fixed-position, so it cannot cover
  the header, drawers, or the floating actions.
- **Images:** `src/components/ui/SafeImage.js` resolves live Supabase Storage →
  committed copy under `/media/<bucket path>` → placeholder. `src/lib/resilience.js`
  builds the same-origin mirror URL and refuses traversal or non-Supabase URLs.
  `vercel.json` serves `/media/*` with `Cache-Control: public, max-age=31536000,
  immutable`; upload filenames are random and never overwritten, so this is safe.
- **Orders:** `placeOrder` now returns the HTTP `status`; checkout offers the
  prefilled WhatsApp hand-off only on `0`/`408`/`≥500`, never on validation
  errors. The server stays authoritative and the Telegram notification path is
  unchanged.
- **Tooling:** `scripts/resilience-sync.mjs` writes the snapshot and copies the
  product/size-guide images into `public/media/`. It stores files atomically,
  skips byte-identical copies, refuses keys outside `products/`, rejects any
  single image above **1.5MB** (`MIRROR_MAX_FILE_MB`; stale mirrors of oversized
  files are removed and the run exits non-zero), and aborts past a **200MB**
  total budget (`MIRROR_MAX_MB`). `--prune` deletes mirrored files that no
  snapshot product references (and the empty folders); `--force-prune` is needed
  only when `products_public` itself returns zero rows. Product ids that must
  stay out of the backup without touching Supabase are listed in
  `scripts/resilience-exclude.json`. No R2 client or dependency remains.
- **Data shipped:** `public/catalog-snapshot.json` is intentionally **empty**
  (`count: 0`, `excludedIds: ["1793846979234526"]`) and `public/media/` contains
  no images: the only live row is the temporary/test product, which the owner
  asked to keep out of the shipped backup. Running the sync with `--prune`
  removed the previous 5 images (~1.0MB). Once a real product is published,
  remove its exclusion (if any) and re-run `npm run resilience:sync`.
- **Tests:** `scripts/test-resilience.mjs` — 106 passed, 0 failed, including the
  per-image/total limits, the exclusion list, the prune dry-run/real-run, and a
  check that the committed mirror contains only referenced images. Full
  `ZSHM_REQUIRE_SQL_TESTS=1 npm test` — every suite green (the real-PostgreSQL
  harness reports 475 passed, 0 failed). `npm run build` passes and the bundle
  contains no server secret.
- **Browser verification:** with `VITE_SUPABASE_URL` pointed at an invalid host,
  the homepage rendered the real product from the snapshot, showed the backup
  banner and the WhatsApp CTA, and loaded the images from `/media/products/…`.
  Live mode was verified separately on 2026-11-07 (commit ae6deea deployed):
  real Supabase images, no banner, Size Guide and selected-size pills identical
  (26/28/30px heights at 320/375/768px), review fields 13px at >=769px and
  16px at <=768px, WhatsApp FAB at `z-index: 30000`, clean console).
- **Still required (future, on first real product):** drop its id from
  `scripts/resilience-exclude.json` (if it was added) and run
  `npm run resilience:sync -- --prune`; review the new snapshot and the
  `public/media` size, then commit/push/deploy with explicit owner approval.
- **Deployment record (2026-11-07):** committed as `ae6deea`, pushed to
  `origin/main`, deployed by Vercel Git integration. Live bundle
  `/assets/index-HD5wpGoL.css` (matches local build hash) contains `review-form`
  and `data-size-value`; `/catalog-snapshot.json` returns the empty backup with
  `excludedIds: ["1793846979234526"]`. Full `npm test` (SQL 475/475) and
  `npm run build` passed with no secrets.

### 13.9 Optimistic confirmation during a database outage (2026-11-10, uncommitted)

> **SUPERSEDED 2026-11-22 — historical record only.** The owner reversed this
> decision: a shopper must NOT be told an unsaved order was confirmed. The
> current customer contract is in §13.12 below. Do not verify against this
> section.

**Owner decision (2026-11-10):** when the database is unreachable the shopper
must see NOTHING broken. They press PLACE ORDER and get the normal
"order placed / تم تنفيذ طلبك" confirmation. The Telegram alert still arrives
with the same order body plus a banner stating the order was NOT stored.

- **Server (`api/orders.js` + `api/_lib.js`):** `generateOrderId()`/`orderDate`/`createdAt`
  run before any DB call, so every path shares one `ZSH-…` reference. Client display
  data (`items[].unitPrice`, `client.{subtotal,discount,shippingCost,total}`) is
  kept for the alert only; money stays server-authoritative when the DB is healthy.
  `acceptPending(reason)` answers `200 { success: true, pending: true, order }`
  FIRST, then sends the alert (a hung Telegram cannot delay or break the response).
  A `responded` guard prevents a second write. Business refusals (stock, invalid
  coupon, missing/inactive product, idempotency conflict) still return real 4xx;
  only infra failures become "pending". Shipping stays server-derived via
  `getShippingCost(city)` (no DB needed). supabase-js retries network failures
  with 1s/2s/4s backoff (~7s); every checkout DB step now runs under a 3.5s
  `AbortSignal.timeout` deadline (3.7s measured end-to-end).
- **Pending alert (`buildPendingOrderMessage`/`buildPendingOrderActions`):** banner
  `⚠️ ZASHM | تنبيه: الداتابيز معطّلة والأوردر لم يُسجَّل` + reference + time +
  reason + `❗ العميل شاف رسالة «تم تنفيذ طلبك»` + amounts labelled
  `(حسب العميل، غير مؤكد)` only when `amountsFromClient`. Then the EXACT same
  `buildOrderTelegramMessage` body. Buttons: `💬 واتساب للعميل` (direct
  `wa.me/<customer>?text=<prefill>`), `📋 نسخ رقم الطلب`, `🛠 لوحة الطلبات`.
  No tracking link (no row). `ORDER_ALERT_TIMEOUT_MS=4000`, 2 attempts, 400ms
  retry.
- **Client (`src/store.js`, `src/lib/orderConfirmation.mjs`, `src/pages/CartPage.js`):**
  sends the client display fields; retries once on status 0/408 after 600ms;
  handles `payload.pending`; persists `pending`; on a pending order shows a
  reassuring line ("هنكلمك على رقمك لتأكيد تفاصيل الأوردر قبل الشحن.") and HIDES
  TRACK YOUR ORDER. `OutageNotice` banner + `.outage-notice` CSS were REMOVED
  (they were the "something is broken" signal the owner forbids); `.outage-order-cta`
  remains for the genuine client-side network failure, where the WhatsApp fallback
  is still shown because nothing would be recorded anywhere.
- **Browser proof (2026-11-10):** live build served on 127.0.0.1:4399 with
  Supabase = `outage-proof.invalid` and real Telegram creds. Customer saw
  "ORDER CONFIRMED" + reassurance, 0 console/page errors, no WhatsApp fallback,
  no TRACK button; HTTP 200 `pending:true`; Telegram `message_id 179` delivered
  with the new banner + same body + labelled amounts. Latency 3.68s.
- **Tests:** `scripts/test-order-outage.mjs` (49 passed), `scripts/test-notifications.mjs`
  (13 passed, [8]/[9]/[11] rewritten), `scripts/test-order-pricing.mjs` (125 passed,
  [11]-[14] + client fields), `scripts/test-resilience.mjs` (104 passed, [7] asserts
  the notice is gone). Full `npm test`: 25 suites · 2164 passed · 0 failed (SQL suite
  actually ran: 476 passed).

### 13.10 Product-page speed, logo, and prerender (2026-11-10, uncommitted)

- **Logo:** `public/zashm-z-monogram.webp` (4.1KB, 116px, q90) used in
  `src/components/shop/Header.js` + both `src/App.js` img tags (header + splash).
  `public/zashm-z-monogram.png` downscaled to 232×223 / 35KB, still used by
  `src/lib/seo.js` for the JSON-LD logo. Original backed up at
  `/private/var/folders/jt/xbz49b0n6_z32ssk5d3lsqww0000gn/T/agentconfig/zashm-z-monogram-original.png`.
- **Vite:** `vite.config.js` injects `<link rel="preconnect" href="<supabase-origin>"
  crossorigin/>` via `supabasePreconnect()` (confirmed in `build/index.html`).
- **ProductPage:** LCP image gets `fetchPriority="high"` / `loading="eager"` /
  `decoding="async"`; thumbnails `loading="lazy" decoding="async"`. `ProductCard`
  already had eager/lazy + async decode.
- **Prerender:** `scripts/prerender-products.mjs` writes `build/product/<id>/index.html`
  (directory index, NO `cleanUrls`, no `vercel.json` routing change). Injects
  title/description/canonical/OG/Twitter, preload after `<meta charset>`, Product
  JSON-LD (`id="zashm-product-jsonld"`, `<` escaped as `\u003c`), and a `<noscript>`
  fallback. Refuses non-numeric ids, `active === false`, shells without
  `<div id="root"></div>`. Best-effort `main()` (missing env/network/bad payload/
  missing build → log + exit 0). Deliberately does NOT apply
  `scripts/resilience-exclude.json` (live products still deserve metadata).
  `package.json` `build` = `vite build && node scripts/prerender-products.mjs`;
  `npm test` includes `scripts/test-prerender.mjs` (66 passed). Measured:
  `prerender: wrote 1 product page(s)`; raw page verified
  (`Jacket — ZASHM`, canonical/OG on `https://zashm-mo.vercel.app`,
  Supabase image preload, `EGP 2,500` noscript).
- **Caveat:** production serving of the prerendered file cannot be verified
  locally (Vercel CLI logged out). The directory-index approach relies on Vercel's
  default filesystem serving; if rewrites ever win over the filesystem the site
  still works (only no benefit). Middleware (`middleware.ts`) is unchanged.

### 13.11 Storefront weight, login budget, client errors, browser E2E (2026-11-19, uncommitted)

- **supabase-js out of the storefront bundle.** The only browser use was one
  `SELECT * FROM products_public` (uploads already go through
  `/api/admin/upload`). `src/lib/supabase.js` is now config +
  `fetchPublicProducts()` (plain `fetch`, throws on non-2xx/non-array so the
  snapshot fallback is unchanged); `src/store.js`, `src/lib/security.js` and
  `src/components/admin/ImageUploader.js` use it. `syncFromServer` also ignores
  an empty array so a blank response cannot wipe the cached catalogue. Build:
  no `vendor-supabase` chunk (was ~54 KB gzip), `index.html` modulepreloads only
  `vendor-react`, `vendor-motion`, `vendor-icons`; entry 103.40 KB / 33.97 gzip.
- **Per-account login budget.** `api/auth.js` keeps `login:<ip>:<email>` (5) and
  `login:<ip>` (20) and adds `login:acct:<email>` (12 / 15 min) so rotating IPs
  cannot brute-force one account. The three checks run in `Promise.all`; a
  successful login clears the IP+email and account budgets (not the per-IP one).
- **Client error reporting.** `POST /api/errors` (`api/_errors.js`, mounted
  through `api/auth.js` by a `vercel.json` rewrite because the Hobby plan caps a
  deployment at 12 Serverless Functions and this project is at the cap — 11
  handlers + `middleware.ts`): method guard,
  `errors:<ip>` 30 / 10 min, 8 KB body cap, every field sanitised/truncated, one
  greppable `CLIENT-ERROR` log line, and at most one Telegram alert per distinct
  error (6/hour/instance, 30-min dedupe, bounded map). No database, no PII, no
  echo. `src/lib/errorReporting.js` hooks `error`, `unhandledrejection` and the
  React boundary; max 5 reports/page, de-duped, `sendBeacon` → keepalive fetch,
  off in dev and on localhost, path only (no query string, no cookies).
  **No dashboard or stored history**: reports surface in Vercel logs and Telegram
  only.
- **Real browser E2E.** `scripts/test-e2e.mjs` builds `build-e2e/` against a local
  fixture catalogue, serves it with a tiny static server that mocks
  `/rest/v1/products_public` and `/api/*`, and drives headless Chrome over CDP
  with Node 22's global `WebSocket` (no Playwright/Puppeteer dependency). Journey:
  home renders 2 cards → product route/title/price → colour + size → add to bag →
  toast + mobile bag badge → drawer → reload keeps the bag (500 EGP) → empty
  checkout marks required fields and never calls `/api/orders` → 404 view → zero
  console errors. 24 passed locally. CI now uses Node 22 and runs it via
  `npm test`; a missing browser is a hard failure when `CI=true` and a loud SKIP
  otherwise.
- **Tests.** New `scripts/test-error-reporting.mjs` (54 passed, including a
  guard that the deployment stays within the 12-function cap) and a
  `[13] per-account login budget` section in `scripts/test-sessions-admin.mjs`
  (84 passed). `scripts/test-edge-transport.mjs` now also scans `api/_errors.js`
  and accepts the `Promise.all` limiter shape (113 passed). Full local run:
  `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → 0 failed, SQL suite 490 passed on real
  PostgreSQL 17; `npm run build` passes, no secret in the bundle.
- **Deploy note:** the first `vercel --prod` attempt was rejected by the Hobby
  plan ("No more than 12 Serverless Functions"); the endpoint was then mounted
  on `api/auth` and `vercel build` confirms 11 API functions + middleware = 12.
- **Deployed 2026-11-19** as `zashm-hsrkfkuna-zashm.vercel.app` (production
  https://za-shm.vercel.app), from commit `89fbcef`. Production verified:
  `/api/errors` GET → 405, OPTIONS → 204, POST `{}` → 400 (mount works, no
  alert); `/api/auth` GET → 405; unknown path → 404; home serves
  `index-0QRKP_W8.js` with modulepreloads for react/motion/icons only and no
  supabase chunk; the deployed entry has zero `createClient` and one
  `products_public` read; headless Chrome at 390px rendered 2 cards and the
  wordmark with no overflow and no uncaught errors; a product card opened
  `/product/1794943849613141` (T-SHIRT, EGP 880, size M preselected,
  add-to-bag enabled).

### 13.12 Honest outage reply, status precondition, public POST CSRF (2026-11-22, uncommitted)

This supersedes §13.9. Products/catalogue data are explicitly outside this
change and remain the owner's responsibility.

- **C3 — outage reply.** `api/orders.js` `acceptPending(reason)` now answers
  **202 Accepted** with `success: true, pending: true, order`, plus
  `message: 'We received your order and will confirm it shortly.'` and
  `messageAr: 'استلمنا طلبك وسنتأكد منه قريبًا.'`. No fake confirmation, no
  tracking URL, no "confirmed" or "تم تنفيذ طلبك" string. The Telegram owner
  alert now says the customer saw that exact pending line. `apiFetch` treats 202
  as success; `src/store.js` persists `pending` on the confirmation; `CartPage`
  shows a distinct pending receipt (temporary reference, "to be confirmed",
  estimated total, no TRACK button) and **keeps the idempotency key** so a retry
  reuses the same key and cannot create a duplicate once the DB returns.
- **C2 — status precondition.** `src/store.js` captures the status on screen
  (or the value captured when the final-status dialog opened in `AdminApp.js`)
  and sends it as `expectedStatus`; `api/admin/orders.js` uses it as
  `p_expected_status`. A stale tab now gets `409 { code: 'status_changed' }`
  instead of overwriting a newer transition. Legacy callers that omit it still
  fall back to the freshly read row. Non-standard legacy status strings are
  accepted as preconditions (the RPC compares plain text); only syntactically
  malformed values get 422.
- **Public POST CSRF.** `enforceMutationOrigin(req, res)` (Origin allow-list)
  runs before any body read on `/api/orders`, `/api/reviews`,
  `/api/coupons/validate` and `/api/errors`; `readBody()` rejects explicit non-JSON
  Content-Types with **415**. A cross-site form cannot drive these routes.
  Production `ALLOWED_ORIGINS` must contain the exact customer-facing origin.
- **Product images.** `api/admin/products.js` requires HTTPS for the single
  `image` field on create, import and PATCH. `data:`/`javascript:`/`http://`
  values are refused with 422. `images[]` was already filtered.
- **Tracking.** The signed `tk` is stored in tab-scoped `sessionStorage` keyed
  by order id so a refresh of the secure link still works; it is still stripped
  from the address bar. `vercel.json` adds edge `noindex` for any `?track=` /
  `?tk=` query URL (the SPA also serves tracking at `/`).
- **Local proof (this session):** focused suites and full `npm test` pass with
  **0 failed** (real PostgreSQL suite ran); `npx vite build` to a temp outDir
  passes with no secret in the bundle. **No production verification was made.**
- **C4 — RESOLVED (owner-run 2026-11-22).** The owner ran the read-only count
  query and pasted the aggregate rows (no PII). Final state: `admins=1`,
  `total_users=1`, `total_orders=0`, `cancelled_orders=0`,
  `nonzero_reserved_stock=0`, `total_products=1`, `active_products=1`,
  `total_coupons=1`, `active_coupons=1`. The owner deleted all orders on this
  date (pre-deletion `total_orders=9`) and explicitly confirmed that keeping a
  single admin is intentional. The old 2-admin / 8-order baseline and the
  audit's 3-admin / 9-order figure are historical and superseded; see
  `docs/security-production-checklist.md` for the updated baseline. Note: a raw
  `DELETE FROM public.orders` does not reconcile stock or coupon usage — that
  only happens inside `atomic_delete_order` — so a read-only drift check is
  advisable if the deletion was not made through the RPC.

### 13.13 Growth readiness — paged admin API, Speed Insights, local load test (2026-11-23, uncommitted)

Owner-approved scope: lists-only pagination (analytics/notifications keep full
snapshots), Speed Insights via the `@vercel/speed-insights` SDK, and a load test
on isolated local data only. **Nothing here was committed, pushed or deployed.**

- `GET /api/admin/products` and `GET /api/admin/orders` accept optional
  `page`/`pageSize`. With no params the legacy full-list response is unchanged
  (dashboard, 10s poll, notifications, CSV and KPIs depend on it). With params
  the handlers issue one exact head count plus one `.range()` query and return
  `pagination: { page, pageSize, total, totalPages, hasPrev, hasNext }` shaped
  like the UI's existing `paginate()` helper. Params are clamped; raw DB errors
  are never echoed. Orders sort by `date DESC, id DESC` so equal timestamps
  cannot duplicate or skip a row across pages. The exact head count and the
  page query are two statements, so a concurrent insert/delete can make the
  displayed `totalPages` briefly stale; the page itself stays valid and the
  pager clamps out-of-range pages. Regression proof:
  `scripts/test-admin-pagination.mjs` (51 assertions), plus the existing
  products/PII-limit suites.
- Speed Insights is injected once from `src/index.js`. `src/lib/speedInsights.mjs`
  drops datapoints for `/admin`, `/cart`, `/checkout`, `/wishlist`, `/track` and
  `?track=`/`?tk=` URLs. `vercel.json` CSP now allows `va.vercel-scripts.com`
  (script) and `vitals.vercel-insights.com` (fallback intake) only. The SDK is
  available on all Vercel plans; querying metrics through `vercel metrics`
  still requires a Speed Insights Plus subscription. Proof:
  `scripts/test-speed-insights.mjs` (20 assertions), `npm run build`, bundle
  scan showing only the public anon JWT.
- Local load test (not production): PostgreSQL 17.10, 8 vCPU Mac, synthetic
  2,000 products / 5,000 orders, pgbench mixed read/write script, 60 s per
  level. 50 clients: 13,075 TPS, p50 1.94 ms, p95 10.56 ms, p99 27.50 ms.
  100 clients: 5,904 TPS, p50 8.11 ms, p95 64.54 ms, p99 138.72 ms.
  300 clients: 4,556 TPS, p50 24.92 ms, p95 286.58 ms, p99 473.64 ms.
  Zero failed transactions at every level. This measures the database layer
  only (no HTTP/Vercel/PostgREST/Auth), and the local cluster allowed 400
  direct connections — the live project reports `max_connections = 60`, so a
  real 300-client burst must go through the Supavisor pooler.
- Full `npm test` (including the real PostgreSQL concurrency suite) and
  `npm run build` pass; `npm audit --omit=dev` reports 0 vulnerabilities.
  Supabase plan label is not exposed by the Management API here, but the live
  entitlements (1-day logs, no backups/HA/read replicas, 50 MB max upload,
  `max_connections = 60`) match the Free tier. Measured usage is far below the
  official Free quotas; **no Supabase upgrade is justified by current evidence**.
- Deployment approval is still required before the CSP/SDK changes take effect
  in production; after deployment, verify the injected script and that private
  routes emit no Speed Insights events.

### 13.14 WhatsApp button pre-fills the full order message (2026-11-24)

Owner reported that tapping the Telegram WhatsApp button opened a chat with only
the order number and tracking link, not the confirmation text that arrived in
Telegram. The old minimal `?wa=1` prefill from the 2026-11-20 hardening is
therefore superseded for the verified hand-off only.

- `api/orders.js`: after `verifyTrackToken` succeeds, the `?wa=1` branch builds
  `buildOrderTelegramMessage(order, order.tracking_url)` — byte-identical to the
  Telegram body, including the STORED tracking link and its original token — and
  redirects to `whatsAppDeepLink(order.phone, message)`. The read path no longer
  mints a fresh `tracking_url` (it only supplies one for legacy rows without a
  stored link). The redirect remains `Cache-Control: no-store`, the button URL
  remains short and token-only, and no message content is logged. This applies
  to both Vercel and the Cloudflare Worker because the Worker reuses
  `api/orders.js`.
- `api/_lib.js`: removed the now-unused `buildOrderHandoffPrefill` helper.
  `buildWhatsAppPrefillMessage` stays in use for the database-outage alert.
- Security trade-off accepted by the owner: the final `wa.me` URL necessarily
  contains the customer details because WhatsApp prefill has no out-of-band
  channel. They stay out of the Telegram button URL, server logs and cached
  responses; the signed token is still the only credential for the redirect.
- Regression proof: `scripts/test-notifications.mjs` asserts the button URL has
  no PII while the full confirmation does; `scripts/test-final-hardening.mjs`
  asserts the decoded `?wa=1` redirect equals the exact Telegram message and
  still requires a valid token, one DB lookup and a no-store response.
- **Deployment (owner-approved 2026-11-24, direct Production only):** deployed
  to Cloudflare Worker `zashm` with
  `wrangler deploy --config wrangler.production.toml --tag wa-full-prefill-20261124`.
  New Version `290b79bc-79a9-4601-96f9-b20518ca1610` is active at 100% in
  deployment `0ccec3c5-0bad-46d2-993a-0347b8d73dff`
  (`2026-11-24T19:19:59.778466Z`). The previous rollback target remains Version
  `e0c390f5-7e70-49a0-ac73-200a3da4eec6` / deployment
  `daaea4fe-f226-4fb2-a27f-2f71ceabe268`. No assets changed (46 files reused),
  no secret rotated and no Vercel/Supabase/DNS change. A read-only fetch of the
  live Worker script confirms the new `if (!order.tracking_url)` guard and
  full-message hand-off are present and the
  old minimal helper is absent. GET-only smoke: 13 routes returned the expected
  statuses (pages 200, unknown 404, admin API 401, unauthenticated track
  200 `{found:false}`) with noindex on every response. No commercial test order
  was placed, so the live full-message prefill itself was not exercised; it is
  proven by the handler tests and the deployed script check.

### 13.15 Newest sort keeps a neutral pressed state (2026-11-24)

Owner reported that the `Newest` sort beside `Filter` turned yellow/gold when
pressed. `src/index.css` now keeps the smoked-glass dark surface on
`:active`/`:focus`/`:focus-visible`, brightens the border/text, and adds a
neutral white keyboard focus ring; the champagne fill and dark-chevron swap are
gone. The small gold chevron remains by design (it is not a fill). Sorting,
focus/blur behaviour and the stored selection are unchanged. `ShopPage.js`
only updates stale comments; static and browser tests were updated to reject a
gold fill.

Verification: `node scripts/test-ux-fixes.mjs` → 115 passed / 0 failed,
`node scripts/test-e2e.mjs` → 36 passed / 0 failed (real headless Chrome),
`ZSHM_REQUIRE_SQL_TESTS=1 npm test` → 37 scripts / 4112 passed / 0 failed with
the real PostgreSQL 17 suite running (495 passed), `npm run build` →
`index-9KxDlqjO.js` + `index-CMXKf8h2.css`, and `git diff --check` clean.
Browser inspection on the local shop page confirmed the focused control kept
`rgb(21, 21, 21)` with a white overlay and neutral border while the chevron
stayed gold. Reviewer sign-off was APPROVE with no Blocker/High/Medium finding;
the one Low test-strength note (focus-ring cascade order) was fixed.

- **Deployment (owner-approved 2026-11-24, direct Production only):** the final
  Worker version is `1392dfc3-2454-484d-8e88-e05e54c7b86a`, active at 100% in
  deployment `fc0f7712-6354-423b-ac08-30d4aa950332`
  (`2026-11-24T19:55:24.139763Z`, tag `sort-neutral-final-20261124`). The first
  deployment with this change (`502b2feb-614c-4b6f-b014-42f1785489e9` /
  `2ca10c45-052f-42e4-85bf-07479161c31c`) was immediately superseded because
  `build:production:prep` had baked a placeholder anon key and
  `production-prep.invalid` sitemap origin. The final build used the real
  Production public origin and anon key at build time, with no service-role
  secret in the bundle; live asset checks confirmed the real sitemap URL, new
  hashed assets, neutral press CSS, absence of the old gold fill, and retained
  WhatsApp markers. GET-only smoke covered 13 routes with the expected statuses
  (pages 200, unknown 404, admin API 401, unauthenticated track 200) and noindex
  on every applicable response.
- **Rollback:** prefer the last known-good stable version
  `290b79bc-79a9-4601-96f9-b20518ca1610` / deployment
  `0ccec3c5-0bad-46d2-993a-0347b8d73dff` (§13.14). The immediate preceding
  version `2ca10c45-052f-42e4-85bf-07479161c31c` is not a recommended rollback
  target because its assets came from the placeholder prepared build. No
  Supabase, Vercel, DNS or secret setting was changed.
