# تقرير المراجعة النهائية للجاهزية للإنتاج — ZASHM

**التاريخ:** 2026-11-01  
**الفرع / الكوميت:** `main` @ `a0e78f4` (`security hardening`)  
**نوع المراجعة:** المراجعة الأصلية قراءة فقط (Read-only audit). بعدها نُفِّذت **معالجات محلية آمنة** موثقة في §11: لم يتم تنفيذ أي SQL على الإنتاج، ولا نشر، ولا تعديل بيانات إنتاج، ولا commit/push/merge، ولا تغيير في Vercel أو Supabase Dashboard.  
**النطاق:** قاعدة البيانات وملفات Supabase، واجهات `/api`، واجهة المتجر ولوحة الإدارة، إعدادات Vercel، الاختبارات، والبناء.  
**قيود المراجعة:** لا وصول إلى Supabase Dashboard أو Vercel أو بيانات الإنتاج، ولا متصفح حقيقي. كل ما يخص الإنتاج هنا مبني على الكود والملفات وتقارير التشغيل المقدمة، وليس على استعلام مباشر للإنتاج.

**وسيلة التصنيف:**

- **مؤكد (Confirmed):** مسار الكود واضح ويمكن إثباته من الملفات.
- **محتمل (Potential):** يعتمد على حالة إنتاج غير متاحة للمراجعة (سياسات RLS، بيانات، إعدادات).
- **مقبول (Accepted):** خطر معروف ومُدار بقرار موثق.
- **لا مشكلة (No issue):** تم فحصه ولم يُوجد خلل.

> **تحديث ما بعد المعالجة (2026-11-01):** هذا التقرير يوثّق المراجعة الأصلية، ثم يضيف **§11 — مصفوفة حالة ما بعد المعالجة** التي تغطي كل معرّف. المعالجات كلها **محلية وغير مُنشورة** فوق `a0e78f4`؛ لم يُطبَّق أي منها على الإنتاج. عند التعارض بين §1–§10 و§11، **§11 هو المرجع** لحالة كل بند. الحكم النهائي بقي **Conditional Go** حتى تكتمل الفحوصات اليدوية على الإنتاج.

---

## 1. الملخص التنفيذي

### 1.1 الحكم المختصر

**الواجهة والـ API أصبحا أقوى أمنيًا بشكل واضح، لكن المشروع ليس جاهزًا بعد لإعلان «Production-ready» بشكل نهائي.**  
السبب ليس ثغرة حرجة مؤكدة، بل **خلل إداري مؤكد عالي الخطورة** (لوحة المنتجات تقرأ من العرض العام `products_public`، فالمنتجات غير النشطة تختفي، وحقل `tags` يُمسح عند الحفظ) — **عُولج محليًا في §11/H-01 لكنه لم يُنشر** — إضافة إلى **مخاطر ترتيب النشر** (Phase 3) و**بنود يدوية** لم تُنفذ أو لم يتم التحقق منها من داخل هذه البيئة.

**التصنيف النهائي: CONDITIONAL GO / NOT YET PRODUCTION-READY**  
أي: يمكن تشغيل المتجر، لكن لا يصح اعتباره «جاهزًا للإنتاج بالكامل» قبل إغلاق بنود P0 في القسم 10.

### 1.2 ما تم إثباته

- **817 اختبارًا محليًا ناجحًا، 0 فشل** بعد المعالجة (كان 783 قبلها)، موزعة على 9 مجموعات، منها **202 اختبار SQL حقيقي** على PostgreSQL 17 محلي مؤقت (وليس الإنتاج).
- **بناء الإنتاج ناجح:** Vite 7.3.7، 2555 module، زمن 2.60s، 22 ملفًا.
- **لا توجد أسرار خدمة داخل `build/`:** تم البحث عن قيم `SUPABASE_SERVICE_ROLE_KEY` و`SESSION_SECRET` و`TELEGRAM_BOT_TOKEN` و`TELEGRAM_CHAT_ID` داخل ملفات البناء — النتيجة 0 لكل منها (بدون طباعة أي قيمة).
- **مرجع Supabase في CSP يطابق `.env`:** تمت المقارنة بدون طباعة القيم — النتيجة `match=yes`.
- **العرض العام `products_public`:** يفلتر `WHERE active IS TRUE`، ويستخدم قائمة أعمدة صريحة لا تحتوي `reservedStock`، وPhase 3 يسحب صلاحيات الجدول والأعمدة من `PUBLIC` و`anon` و`authenticated` ويثبت ذلك بـ`has_table_privilege()` و`aclexplode(attacl)`.
- **الطلبات:** السعر والشحن والكوبون والمخزون تُحسب في السيرفر، و`atomic_place_order` يقفل صفوف المنتجات بترتيب ثابت ويمنع التكرار عبر idempotency.
- **الجلسات:** كوكي `HttpOnly; Secure; SameSite=Strict`، وCSRF double-submit، وفحص Origin للطلبات غير الآمنة، وإعادة قراءة المستخدم من قاعدة البيانات في كل طلب إداري.

### 1.3 ما لم يتم إثباته

- **لم يتم فحص الإنتاج مباشرة:** تعريف العرض الفعلي، سياسات RLS الفعلية، صلاحيات `anon/authenticated` الفعلية، وحالة phase 3 على الإنتاج.
- **لم يتم تشغيل متصفح حقيقي** لفحص الـ console أو الشبكة أو الـ CSP أو تجربة الشراء من البداية للنهاية.
- **لا توجد بيانات `pg_stat_user_indexes`**، لذلك لا يمكن تبرير حذف أي index.
- **لا توجد بيئة staging**، ولم يتم تنفيذ أي اختبار تدميري أو اختبار حمل على الإنتاج.

---

## 2. الأمان

### 2.1 جدول النتائج الأمنية

| ID | الخطورة | الموقع | ماذا وجدنا / لماذا يهم | الإصلاح المقترح | أثر الإنتاج | التصنيف |
|---|---|---|---|---|---|---|
| S-01 | مقبول | `supabase/products_public_view.sql:27-37`, `:156-157` | العرض `products_public` يعمل بـ`security_invoker=false` (owner rights) و`security_barrier=true`. هذا مقصود: `security_invoker=true` سيحتاج منح `anon` قراءة الجدول الأساسي، وهذا يعيد كشف `reservedStock`. | **لا تغيّر.** أبقِ العرض مملوكًا لدور موثوق (`postgres`) وواصل حراسة قائمة الأعمدة. | لا يوجد كسر؛ العرض يقرأ الجدول الأساسي بصلاحيات المالك. | **Accepted** |
| S-02 | لا مشكلة | `supabase/products_public_view.sql:228-258`, `:266-277` | Phase 3 يسحب صلاحيات الجدول **وصلاحيات الأعمدة** من `PUBLIC` و`anon` و`authenticated`، ثم يتحقق من عدم بقاء أي ACL على الأعمدة. | لا شيء. | يمنع `?select=reservedStock` المباشر حتى لو وُجد grant عمود قديم. | **No issue** |
| S-03 | لا مشكلة | `supabase/products_public_view.sql:112-121`, `src/store.js:221-223` | `reservedStock` غير موجود في قائمة الأعمدة، والميجريشن يرفض إضافته. الواجهة تقرأ `products_public` وليس الجدول الأساسي. | لا شيء. | لا يظهر حقل الحجز الداخلي للمتصفح. | **No issue** |
| S-04 | لا مشكلة | `supabase/products_public_view.sql:228`, `scripts/test-sql-concurrency.mjs:663-670` | سحب الصلاحيات من `PUBLIC/anon/authenticated` لا يمس `service_role`؛ الاختبار المحلي يثبت بقاء `SELECT/INSERT/UPDATE/DELETE`. | لا شيء. | الـ API الإداري والـ service role يستمران في العمل. | **No issue** |
| S-05 | مقبول | `docs/security-production-checklist.md:238-262` | جداول `coupons` و`orders` و`users` و`zshm_deploy_flags` و`zshm_storage_policy_backup` لديها RLS بدون policies = deny-all للمتصفح. هذا مقصود، و`service_role` يتجاوز RLS. | **لا تضف policy** لتسكيت الـ linter. | لو أضفت policy permissive ستعرض PII أو الكوبونات. | **Accepted** |
| S-06 | لا مشكلة | `api/_lib.js:128-175`, `:470-507` | كوكي الجلسة `HttpOnly; Secure; SameSite=Strict; Path=/`، وCSRF cookie غير HttpOnly للـ double-submit، وفحص Origin + CSRF للطلبات غير الآمنة عند المصادقة بالكوكي. | لا شيء. | يحمي من CSRF وسرقة الكوكي عبر JS. | **No issue** |
| S-07 | لا مشكلة | `supabase/session_revocation.sql:14`, `api/admin/users.js:179-195` | تغيير الدور أو كلمة المرور يرفع `session_version`، و`requirePerm` يعيد قراءة الصف ويرفض التوكن القديم. | لا شيء. | إبطال فوري للجلسات عند تغيير الصلاحيات. | **No issue** |
| S-08 | لا مشكلة | `api/_lib.js:540-600` | كلمات المرور الجديدة scrypt (N=16384, r=8, p=1)، مع ترقية تلقائية للهاشات القديمة عند تسجيل الدخول، وdummy hash للإيميل غير الموجود. | لا شيء. | يمنع تمييز الإيميلات ويقوي التخزين. | **No issue** |
| S-09 | متوسط | `api/auth.js:59-62`, `api/_lib.js:108` | **تسجيل الخروج يمسح الكوكيز فقط ولا يرفع `session_version`.** أي توكن مسروق يظل صالحًا حتى 4 ساعات. | أضف `logout-all` يرفع `session_version` (يتطلب تعديل صف المستخدم)، أو قصّر TTL، أو أضف قائمة إبطال. | سرقة كوكي = وصول إداري حتى 4 ساعات. | **Confirmed** |
| S-10 | متوسط / عالي | `api/_lib.js:297-318`, `api/auth.js:78-79` | الـ rate limiter يعمل in-memory عندما لا يكون Upstash مضبوطًا. مع Serverless متعدد النسخ، الحد يصبح «لكل نسخة» وليس عامًا. | اضبط `UPSTASH_REDIS_REST_URL/TOKEN`، أو أضف بديلًا دائمًا. | تخمين كلمات مرور أو spam للطلبات موزعًا على النسخ. | **Confirmed / Accepted مؤقتًا** |
| S-11 | متوسط | `api/_lib.js:612-627` | توكن التتبع = HMAC لمعرّف الطلب باستخدام `SESSION_SECRET`، بلا تاريخ انتهاء. تدوير السر يُبطل كل روابط التتبع القديمة. | أضف `exp` و/أو `version` داخل التوكن، ووثّق أثر تدوير السر. | روابط قديمة تتوقف بعد التدوير؛ لا تسريب حاليًا. | **Confirmed** |
| S-12 | متوسط / محتمل | `supabase/security_hardening.sql:95-101`, `docs/security-production-checklist.md:92-120` | Trigger على `auth.users` قد ينشئ صف `public.users` بدور `support` عند التسجيل العام، بدون `passwordhash` (لا يمكن الدخول به مباشرة، لكنه يلوث المستخدمين). | أغلق التسجيل العام من Supabase Auth، أو احذف/عدّل الـ trigger بعد مراجعة مصدره. | صفوف support غير مرغوبة عند فتح signup. | **Potential / Manual** |
| S-13 | عالي / محتمل | `supabase/products_public_view.sql:73`, `:156-157` | العرض owner-rights **لا يرث فلاتر RLS الخاصة بالجدول**. هو يطبّق `active IS TRUE` فقط. لو كان على `products` policy إضافية تخفي صفوفًا (مثل ملكية/tenant)، فالعرض سيعرضها. | قبل Phase 3: افحص `pg_policies` و`pg_get_viewdef` على الإنتاج. إن وُجد predicate إضافي، انسخه إلى العرض قبل سحب الصلاحيات. | تسريب صفوف منتجات كانت RLS تخفيها. | **Potential — يتطلب فحص إنتاج** |
| S-14 | لا مشكلة | `api/admin/upload.js:41-70`, `api/_lib.js:1131-1175` | رفع الصور يتحقق من الحجم، ويفك base64، ويعتمد magic bytes لا MIME المعلن، ويولّد اسمًا عشوائيًا، ويمنع path traversal عند الحذف. | لا شيء. | يمنع رفع ملفات متنكرة كصور. | **No issue** |
| S-15 | لا مشكلة | `vercel.json:12-36`, `api/_lib.js:69-95` | CSP صارم، `frame-ancestors 'none'`، HSTS، nosniff، COOP، وCORS بقائمة أصول صريحة. | لا شيء. | يقلل XSS/clickjacking. | **No issue** |
| S-16 | منخفض | `.env.example:2-6`, `vite.config.js:15-17`, `src/lib/supabase.js:4-5` | `.env.example` يعلن `VITE_*` بينما البناء يضخ `REACT_APP_*`، والعميل يدعم الاثنين. هذا يسبب لبسًا في الإعداد المحلي. | وحّد الأسماء أو وثّق الاثنين بوضوح، وأضف `UPSTASH_*`. | إعداد خاطئ محليًا، وليس تسريبًا. | **Confirmed / Low** |
| S-17 | متوسط | لا يوجد `.github/`؛ `scripts/test-sql-concurrency.mjs:536-547` | اختبار SQL يُطبع `SKIPPED` ويخرج بنجاح إذا لم يوجد PostgreSQL، إلا إذا ضُبط `ZSHM_REQUIRE_SQL_TESTS=1`. لا توجد CI. | أضف CI يشغّل PostgreSQL 15+ مع `ZSHM_REQUIRE_SQL_TESTS=1`. | اختبارات الأمان قد تُتخطى بصمت قبل النشر. | **Confirmed** |
| S-18 | منخفض / مقبول | `vercel.json:31` | `img-src` يسمح `https:` لأي مضيف، لأن صور المنتجات قد تكون خارجية. هذا يسمح ببيكسل تتبع خارجي لكنه لا ينفذ Script. | لو أردت تضييقًا: اسمح لمضيفي Supabase وUnsplash/Cloudinary فقط. | تتبع صور خارجي محتمل. | **Accepted** |
| S-19 | لا مشكلة | فحص `build/` و`git grep` | لا توجد قيم أسرار خدمة داخل البناء، ولا أنماط مفاتيح خاصة في الملفات المتعقبة (باستثناء placeholders في `.env.example`). | لا شيء. | لا تسريب أسرار من الحزمة. | **No issue** |
| S-20 | منخفض | `api/_lib.js:1028-1038` | `maskOrderForLimitedAccess` مُصدَّر لكنه غير مستخدم؛ لا يوجد مسار «رقم الطلب فقط» لأنه مرفوض أمنيًا. | احذفه أو استخدمه في مسار مستقبلي موثق. | كود ميت فقط. | **No issue / Low** |

### 2.2 مراجعة تحذيرات Linter — قرار لكل تحذير

| التحذير | القرار | السبب | ما يجب فعله |
|---|---|---|---|
| `public.products_public` هو SECURITY DEFINER view | **Keep** | `security_invoker=false` ضروري لأن `security_invoker=true` سيتطلب منح `anon` قراءة الجدول الأساسي، ما يعيد كشف `reservedStock`. العرض محمي بقائمة أعمدة + `active IS TRUE` + Phase 3. | لا تسكته بمنح الجدول الأساسي. وثّق القرار (موجود في §7.1). |
| RLS enabled with no policies على `coupons/orders/users/zshm_deploy_flags/zshm_storage_policy_backup` | **Keep** | هذه deny-all مقصودة. الـ API يستخدم `service_role` الذي يتجاوز RLS. إضافة policy permissive ستكشف PII/كوبونات. | لا تضف policies. تحقق من `rolbypassrls` لـ`service_role`. |
| `coupons_code_idx` غير مستخدم | **Keep** | يستخدمه البحث بالكود في `/api/coupons/validate` و`/api/orders`. قد يكون مكررًا مع unique/PK، لكن لا دليل. | افحص `pg_index`/`pg_constraint` قبل أي حذف. |
| `coupons_active_dates_idx` غير مستخدم | **Keep** | لا استعلام حالي يفلتر الثلاثة معًا، لكن الحذف بلا بيانات استخدام مخاطرة. | اجمع `pg_stat_user_indexes` لفترة تمثيلية. |
| `orders_date_idx` غير مستخدم | **Keep** | `/api/admin/orders` يرتب بـ`date DESC`؛ قد يظهر مستخدمًا مع كبر الجدول. | نفس المصدر. |
| `orders_status_idx` غير مستخدم | **Keep** | لا استعلام يفلتر بالحالة حاليًا، لكن تكلفة الكتابة منخفضة. | نفس المصدر. |
| `products_category_idx` غير مستخدم | **Keep** | الفلترة حاليًا client-side، لكن التقارير/الاستعلامات اليدوية قد تستخدمه. | نفس المصدر. |
| Supabase Auth: signups / leaked password / MFA | **Open / Manual** | لا يمكن ضبطها من المستودع. | نفّذ خطوات §3 من `docs/security-production-checklist.md`. |

**قاعدة مهمة:** لم يتم حذف أي index، ولم يتم إسكات أي تحذير بمنح صلاحية أو إضافة policy. كل تحذير له قرار مكتوب.

---

## 3. الطلبات والمخزون

### 3.1 ما يعمل بشكل صحيح

| ID | البند | الموقع | النتيجة | التصنيف |
|---|---|---|---|---|
| O-01 | السعر والشحن والكوبون والإجمالي تُحسب في السيرفر | `api/orders.js:185-219` | السيرفر يتجاهل `client.total` و`client.shippingCost` ويعيد الحساب من قاعدة البيانات. | **No issue** |
| O-02 | قفل صفوف المنتجات بترتيب ثابت | `supabase/atomic_place_order.sql:195-221` | `FOR UPDATE` بترتيب `id` تصاعدي، مع رفض المنتج المفقود. | **No issue** |
| O-03 | Idempotency | `supabase/atomic_place_order.sql:166-221`, `:377-425`; `src/pages/CartPage.js:243-247` | نفس المفتاح + نفس السلة = `duplicate`، نفس المفتاح + سلة مختلفة = `idempotency_conflict`. | **No issue** |
| O-04 | رفض المنتج غير النشط | `api/orders.js:108`; `supabase/atomic_place_order.sql:238-241` | الـ API وRPC يرفضان `active = false` حتى لو كان المنتج في سلة محفوظة. | **No issue** |
| O-05 | دورة حياة الطلب ذرّية | `supabase/atomic_order_lifecycle.sql:169`, `:278`; `api/admin/orders.js:94`, `:160` | تغيير الحالة/الحذف يقفل الطلب ثم يعيد المخزون/الكوبون في نفس المعاملة. | **No issue** |
| O-06 | الكوبون داخل المعاملة | `supabase/atomic_place_order.sql:306-368`; `api/orders.js:195-219` | قفل صف الكوبون، إعادة حساب الخصم، رفض `coupon_changed`، وزيادة الاستخدام فقط بعد نجاح الإدخال. | **No issue** |
| O-07 | استعادة المخزون عند الإلغاء/الحذف | `supabase/atomic_order_lifecycle.sql:268-340` | لا استعادة مزدوجة لطلب ملغي، والحذف لا يعيد مخزونًا سبق استعادته. | **No issue** |
| O-08 | تعديل المخزون ذرّي | `supabase/atomic_place_order.sql:490-690` | `atomic_adjust_stock` يقفل كل المنتجات بترتيب ثابت ويتحقق من كل السطور قبل أي كتابة. | **No issue** |
| O-09 | تاريخ الطلب | `api/orders.js:37-40` | يقبل تاريخ المتصفح المحلي فقط إن كان قريبًا من تاريخ القاهرة (±2 يوم). | **No issue** |
| O-10 | تتبع الطلب | `api/orders.js:388-396` | لا يكشف وجود الطلب بدون `tk` صالح؛ الرد نفسه للمعرّف المجهول. | **No issue** |

### 3.2 نقاط تحتاج قرارًا أو متابعة

| ID | الخطورة | الموقع | ماذا وجدنا / لماذا يهم | الإصلاح المقترح | أثر الإنتاج | التصنيف |
|---|---|---|---|---|---|---|
| O-11 | متوسط | `supabase/atomic_order_lifecycle.sql:34-43`, `:275`; `api/admin/orders.js:174-184` | حذف طلب يحتوي منتجًا محذوفًا نهائيًا يجعل `atomic_adjust_stock` يرفض **كل** السطور (`missing_product`)، فتُفقد استعادة مخزون السطور الأخرى. الـ API يُرجع `stockRestored=false` و`warnings`، لكن الأثر الدائم على المخزون يبقى. | الأفضل: منع حذف المنتج إذا كان مرتبطًا بطلبات غير ملغاة. أو استعادة جزئية للسطور الموجودة + تقرير فروقات إلزامي. | خسارة مخزون دائمة تحتاج تسوية يدوية. | **Confirmed / Accepted** |
| O-12 | متوسط | `api/orders.js:132`; `src/store.js:352-356`; `supabase/atomic_place_order.sql:264`, `:289` | `reservedStock` لا يزال يُقرأ في السيرفر وفي حساب التوفر بالواجهة، لكن **لا يوجد كاتب/دورة حياة** له (SEC-24). الواجهة تقرأ 0 دائمًا من العرض، والسيرفر يطرح قيمة قد تكون دائمًا 0. | قرار: إما إزالة الحقل من الحساب/الجداول، أو إضافة كاتب ودورة حياة واضحة. لا تتركه كحقل شبحي. | إن ظهر كاتب مستقبلي، يصبح حساب التوفر في الواجهة مضللًا. | **Open decision** |
| O-13 | منخفض | `src/store.js:574-590` | تحديث حالة الطلب في الواجهة متفائل (optimistic) ثم يُرجع الحالة عند الفشل عبر `refreshOrders`. سليم، لكنه يعتمد على الشبكة. | لا شيء عاجل. | تجربة مستخدم فقط. | **No issue** |
| O-14 | منخفض | `api/admin/orders.js:32-50` | قائمة الطلبات تُرجع كل الطلبات (PII) لأي دور لديه `orders.read`، بما في ذلك `support`. | هذا تصميم مقصود، لكن راجع سياسة الوصول والاحتفاظ بالبيانات. | وصول موظفين إلى PII. | **Accepted** |

**ملاحظة مهمة:** لا توجد مشكلة مؤكدة في حساب الأسعار أو الخصم أو المخزون على مستوى الـ API/RPC. القوة الأساسية هنا جيدة: السيرفر هو المرجع، والـ RPC هو المعاملة الذرّية.

---

## 4. الواجهة الأمامية

| ID | الخطورة | الموقع | ماذا وجدنا / لماذا يهم | الإصلاح المقترح | أثر الإنتاج | التصنيف |
|---|---|---|---|---|---|---|
| F-01 | **عالي** | `src/pages/AdminApp.js:1108`, `:1266-1275`, `:1326-1327`; `src/store.js:221-238`; `supabase/products_public_view.sql:112-119`, `:157`; `api/admin/products.js:314-319` | **لوحة إدارة المنتجات تقرأ من `products` في الـ store، والـ store يقرأ من `products_public`.** النتيجة: (1) المنتجات غير النشطة لا تظهر في اللوحة ولا يمكن إعادة تفعيلها؛ (2) العرض لا يحتوي `tags`، و`openEdit` ينسخ المنتج بدون `tags`، ثم `handleSave` يرسل `tags: ''`، فيمسح `tags` الأصلي عند أي تعديل. لا يوجد `GET /api/admin/products` يعيد الصف الكامل. | أضف `GET /api/admin/products` محميًا بـ`requirePerm('products.read')` يعيد الصفوف الكاملة بـ`service_role`، واجعل `ProductsPanel`/`Dashboard` يقرآن منه. أو على الأقل لا ترسل `tags`/`active` إن لم تكون موجودة في النموذج. | فقدان بيانات `tags` + إخفاء المنتجات المعطلة + تقارير مخزون ناقصة. هذا خلل إداري حقيقي. | **Confirmed** |
| F-02 | متوسط | `src/store.js:219-245`; `src/pages/ShopPage.js:600`; `src/pages/HomePage.js:8-20` | عند فشل قراءة `products_public` (403/شبكة)، الـ store يضبط `productsError`، لكن ShopPage/HomePage لا تعرضانه؛ تظهر «No Products Found» كأن المتجر فارغ. | اعرض حالة خطأ + زر إعادة محاولة، ولا تخلط بين «لا توجد منتجات» و«فشل التحميل». | إخفاء عطل حقيقي عن العميل والفريق. | **Confirmed / Medium** |
| F-03 | منخفض | `src/pages/ShopPage.js:152-155` | خيار «Best Seller» يفرز بـ`product.sales`، وهو حقل غير موجود في العرض ولا في الجدول. النتيجة: الفرز no-op (يبقى الترتيب الأصلي). | استخدم `label === 'Best Seller'` أو أضف حقل مبيعات محسوبًا من السيرفر. | ترتيب مضلل في المتجر. | **Confirmed / Low** |
| F-04 | متوسط / منخفض | `src/pages/TrackOrder.js:53-61`, `:108-135`; `api/orders.js:388-396` | الصفحة تطلب من المستخدم إدخال «Order ID»، لكن البحث لا يعمل بدون `tk` من الرابط، ويظهر `missingToken` فقط. الإدخال اليدوي بلا فائدة. | وضّح أن التتبع يتم من الرابط الآمن فقط، أو أضف مسار تحقق (رقم + رقم هاتف) مع rate limit. | إرباك العميل ودعم فني زائد. | **Confirmed / Medium** |
| F-05 | منخفض | `src/components/admin/ImageUploader.js:385` | `<img>` بدون `alt` في معاينة الصور الإدارية. | أضف `alt=""` للصورة الزخرفية أو وصفًا. | مخالفة accessibility. | **Confirmed / Low** |
| F-06 | منخفض | `src/pages/HomePage.js:15`, `:18`; `src/pages/ShopPage.js:61`; `src/store.js:233` | بعد إزالة `active` من العرض، كل المنتجات تأتي `active: undefined` ثم `?? true`. فلاتر `p.active !== false` أصبحت dead code. | احذف الفلاتر أو أعد `active` فقط إن كان له معنى في الواجهة. | كود مضلل، لا أثر وظيفي. | **No issue / Low** |
| F-07 | منخفض / محتمل | `src/lib/security.js:114-121`; `src/lib/auth.js:129-138`; `api/_lib.js:446-455` | توجد **ثلاث** خرائط صلاحيات. خريطة `security.js` المصدَّرة غير مستخدمة حاليًا وتفتقد `dashboard.read`، بينما `auth.js` والسيرفر متطابقان. أي استخدام مستقبلي لها سيسبب اختلافًا. | اجعل مصدرًا واحدًا (shared) أو احذف المصدَّر غير المستخدم. | خطأ صلاحيات مستقبلي محتمل. | **Potential / Low** |
| F-08 | منخفض | `index.html:2` | `lang="en"` على موقع محتواه عربي/إنجليزي مختلط. | اضبط `lang="ar"` أو `lang="en"` مع `dir` مناسب حسب اللغة السائدة. | SEO/accessibility. | **Confirmed / Low** |
| F-09 | منخفض | `api/sitemap.mjs`; `vercel.json` | كان الـ sitemap ثابتًا. أصبح `/sitemap.xml` يولّد الصفحة الرئيسية و`/shop` والمنتجات المتاحة من `products_public` باستخدام مفتاح anon، مع canonical routing وfallback آمن. | تحقق من المسار بعد النشر، واضبط `PUBLIC_BASE_URL` إذا كان النطاق الإنتاجي مختلفًا عن الافتراضي. | يعتمد تحديثه على توافر Supabase العام؛ عند الفشل يعيد المسارات الثابتة فقط. | **Fixed locally; deployment verification pending** |
| F-10 | منخفض | `src/pages/AdminApp.js:392-404` | `classifyInventory(products)` يستخدم نفس منتجات العرض العام، فلا يرى المنتجات غير النشطة ويصنّف المخزون على مجموعة ناقصة. | يُحل مع F-01 عبر مصدر إداري كامل. | تقارير مخزون مضللة. | **Confirmed / Medium** |
| F-11 | لا مشكلة | `src/components/shop/ProductCard.js:124-137`, `:145-148` | بطاقة المنتج `role="button"` مع `tabIndex` و`onKeyDown`، وصور lazy/eager مع fallback. | لا شيء. | وصول أفضل. | **No issue** |
| F-12 | لا مشكلة | `src/App.js:25`, `:48-53`; `src/components/ui/ErrorBoundary.js` | ErrorBoundary يمنع شاشة بيضاء عند خطأ render. | لا شيء. | متانة أفضل. | **No issue** |
| F-13 | قيد مراجعة | اختبار متصفح محلي | تم فحص مسارات المتجر الأساسية و404 ومقاسات responsive محليًا؛ لم تُفحص بيئة Preview/Production أو CSP/Network هناك. | اختبر staging أو preview deployment. | لا يمكن تأكيد عدم وجود أخطاء runtime في الإنتاج. | **Local checks done; production limitation** |

---

## 5. النشر والإعدادات

### 5.1 الملفات المتغيرة

**الكوميت `a0e78f4` (36 ملفًا) يشمل:**

- **API:** `api/_lib.js`, `api/auth.js`, `api/orders.js`, `api/admin/orders.js`, `api/admin/products.js`, `api/admin/users.js`, `api/admin/coupons.js`, `api/admin/upload.js`, `api/coupons/validate.js`.
- **الواجهة:** `src/App.js`, `src/store.js`, `src/lib/api.js`, `src/lib/auth.js`, `src/lib/routes.js`, `src/lib/security.js`, `src/pages/AdminApp.js`, `src/pages/CartPage.js`, `src/pages/TrackOrder.js`, `src/pages/NotFoundPage.js`, `src/components/admin/UsersPanel.js`.
- **SQL:** `supabase/atomic_place_order.sql`, `supabase/atomic_order_lifecycle.sql`, `supabase/admin_protection.sql`, `supabase/security_hardening.sql`, `supabase/storage_hardening.sql`, `supabase/products_public_view.sql`.
- **الاختبارات:** `scripts/test-analytics.mjs`, `test-coupons.mjs`, `test-edge-transport.mjs`, `test-final-hardening.mjs`, `test-order-lifecycle.mjs`, `test-order-pricing.mjs`, `test-sessions-admin.mjs`, `test-sql-concurrency.mjs`, `package.json`.
- **الإعداد:** `vercel.json`.
- **التوثيق:** `docs/security-production-checklist.md`.

**في هذه المعالجة (فوق `a0e78f4`، غير مُنشورة):** عُدّلت الملفات المذكورة في §11.6، بما فيها `api/admin/products.js` (إضافة `GET`)، `src/store.js` (`adminProducts`)، `src/pages/AdminApp.js`، `api/_lib.js` (rate limiter/توكن التتبع)، `api/auth.js` (إبطال الجلسة عند logout)، `supabase/products_public_view.sql` (حراسة Phase 3)، وإضافة `.github/workflows/ci.yml` و`scripts/test-admin-products.mjs` و`supabase/verify_production_security.sql`. لم يُعدّل أي SQL على الإنتاج، ولم يُنشر أي شيء.

**ملفات SQL قديمة لم تتغير:** `supabase/coupons_lockdown.sql`, `supabase/session_revocation.sql`.

### 5.2 ترتيب تنفيذ SQL اليدوي (الإنتاج)

> نفّذ كل ملف بمفرده في Supabase SQL Editor بعد مراجعته. لا تنفّذ Phase 3 قبل نشر الواجهة الجديدة.

0. **Pre-flight قراءة فقط (قبل أي شيء):**
   - `SELECT pg_get_viewdef('public.products_public', true);`
   - أعمدة `products` و`information_schema.columns`.
   - `pg_policies` على `products` — هل توجد predicate إضافية غير `active`؟
   - `SELECT count(*) FILTER (WHERE active IS TRUE), count(*) FROM public.products;` — تأكد أن المتجر لن يظهر فارغًا.
   - `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'service_role';`
   - `has_table_privilege` / `aclexplode` للتحقق من الحالة الحالية.

1. `supabase/atomic_place_order.sql`
2. `supabase/atomic_order_lifecycle.sql`
3. `supabase/admin_protection.sql`
4. `supabase/security_hardening.sql`
5. `supabase/coupons_lockdown.sql` — **فقط بعد نشر كود الكوبونات الجديد**، وباتباع SECTION 0 ثم 1 ثم 2.
6. `supabase/session_revocation.sql` — آمن قبل/بعد النشر (الطرفان يبدآن بـ0).
7. `supabase/storage_hardening.sql` — مع مراجعة الـ NOTICE.
8. `supabase/products_public_view.sql` — **Phase 1 فقط** (ينشئ العرض ويمنح SELECT، ويتخطى Phase 3).
9. **انشر الواجهة الجديدة** وتأكد من الشبكة أن المتجر يقرأ `products_public`.
10. أدخل علم النشر:
    ```sql
    INSERT INTO public.zshm_deploy_flags (name, note)
    VALUES ('products_public_frontend_live', 'new bundle deployed')
    ON CONFLICT (name) DO NOTHING;
    ```
11. أعد تشغيل `supabase/products_public_view.sql` — **Phase 3** (سحب الجدول والأعمدة + إثبات ACL).
12. نفّذ فحوصات ما بعد النشر في §5.6.

**لماذا هذا الترتيب؟** لأن `atomic_order_lifecycle` يعتمد على `atomic_adjust_stock` من الملف رقم 1، و`coupons_lockdown` يكسر الواجهة القديمة إذا سُبق النشر، وPhase 3 يكسر الحزمة القديمة إذا سُبق نشر الواجهة.

### 5.3 إعدادات Vercel (بدون طباعة قيم)

| المتغير | مطلوب | الغرض |
|---|---|---|
| `SUPABASE_URL` | نعم | اتصال السيرفر. |
| `SUPABASE_SERVICE_ROLE_KEY` | نعم | وصول إداري — سيرفر فقط. |
| `SESSION_SECRET` | نعم | توقيع الجلسات وروابط التتبع. تدويره يُبطل الجلسات وروابط التتبع القديمة. |
| `ALLOWED_ORIGINS` | مستحسن | أصول المتصفح المسموحة (مثال: نطاق الإنتاج فقط). |
| `PUBLIC_BASE_URL` | مستحسن | أصل روابط التتبع. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | اختياري لكنه مُوصى به | rate limit مشترك بين النسخ. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | اختياري | إشعارات الطلبات. |

**تحقق:**
- لا تضع أي مفتاح خدمة في `VITE_*` أو `REACT_APP_*`.
- تأكد أن `TELEGRAM_BOT_TOKEN` الجديد (بعد التدوير) هو المستخدم.
- أعد نشر Production بعد أي تغيير في المتغيرات.

### 5.4 خطوات Supabase Dashboard اليدوية

**Authentication:**
1. Authentication → Providers → Email: أغلق «Enable sign ups».
2. Require email confirmation إن كان Email Auth مفعّلًا.
3. Authentication → URL Configuration: Site URL = نطاق الإنتاج، وRedirect allow-list = النطاق فقط (بدون wildcards).
4. فعّل MFA (TOTP) لحساب الأدمن إن كانت الخطة تسمح.
5. Password settings: الحد الأدنى 12، وفعّل Leaked Password Protection إن كانت متاحة.

**Storage:**
1. تأكد أن bucket `products`:
   - `public = true` (لأن الصور تُعرض للعامة).
   - `file_size_limit = 5242880` (5MB).
   - `allowed_mime_types` = JPEG/PNG/WebP/GIF/AVIF.
2. إن طبع `storage_hardening.sql` رسالة `MANUAL ACTION REQUIRED` (لأن دور SQL Editor لا يملك `storage.objects`):
   - افتح Dashboard → Storage → Policies.
   - احذف **فقط** السياسات الخاصة بـ`products` والتي طبعها الملف بالاسم.
   - **لا تغيّر ملكية `storage.objects`.**
   - **لا تعطّل RLS.**
   - أعد تشغيل الملف للتحقق.
3. السياسات الاحتياطية محفوظة في `public.zshm_storage_policy_backup`، والاستعادة عبر `public.zshm_restore_storage_policies()` من دور يملك إدارة `storage.objects`.

### 5.5 Phase 3 — تأكيد البوابة

Phase 3 **لا يعمل** إلا إذا وُجد الصف `products_public_frontend_live` في `public.zshm_deploy_flags` (`supabase/products_public_view.sql:218-230`).  
هذا مقصود لمنع كسر الحزمة القديمة. **لا تنشئ العلم قبل نشر الواجهة الجديدة والتحقق من الشبكة.**

### 5.6 فحوصات ما بعد النشر

1. **بـ anon key فقط:**
   - `GET /rest/v1/products_public` → صفوف نشطة فقط، وبدون `reservedStock`.
   - `GET /rest/v1/products?select=reservedStock` → 401/403.
   - `GET /rest/v1/products` → 401/403.
2. **بـ service_role:** إنشاء/تعديل/حذف منتج يعمل، والمنتجات غير النشطة موجودة في قاعدة البيانات.
3. **المتجر:** الصفحة الرئيسية، `/shop`، صفحة منتج، صور، فلاتر، سلة، checkout، كوبون، طلب جديد، رابط تتبع.
4. **الإدارة:** تسجيل دخول، أدوار، منتج جديد/تعديل/حذف، تغيير حالة طلب، إلغاء طلب يعيد المخزون، حذف طلب.
5. **الأمان:** طلب `Origin` أجنبي إلى `/api/admin/users` → 403؛ طلب بدون CSRF → 403؛ `POST /api/orders` بمبالغ عميل مختلفة → السيرفر يتجاهلها.
6. **الـ Console:** لا أخطاء CSP، ولا 404 للأصول، ولا أخطاء شبكة غير مبررة.
7. **الجوال:** Responsive على عرض 320/375/390/430.
8. **البيانات:** المستخدمان الحاليان وأدوارهما كما هما (لا حذف/تعديل).
9. **المراقبة:** راقب Vercel Function logs وأخطاء Supabase أول 24 ساعة.

---

## 6. نتائج الاختبارات

| الاختبار | الأمر | النتيجة | ملاحظات |
|---|---|---|---|
| حزمة الاختبارات الكاملة (آخر تحقق محلي) | `ZSHM_REQUIRE_SQL_TESTS=1 npm test` | **918 passed, 0 failed** | 10 مجموعات: 81 + 90 + 80 + 79 + 74 + 18 + 97 + 126 + 25 + 248؛ تضمنت 248 اختبار SQL محليًا. |
| SQL concurrency / RLS / grants | `node scripts/test-sql-concurrency.mjs` | **248 passed, 0 failed** | PostgreSQL 17 محلي مؤقت، يُدمَّر تلقائيًا. لا اتصال بالإنتاج. |
| اختبار مسار المنتجات الإداري (جديد) | `node scripts/test-admin-products.mjs` | **18 passed, 0 failed** | يثبت `GET /api/admin/products` والصلاحيات والصفوف الكاملة وعدم تسريب أخطاء DB. |
| بناء الإنتاج | `npm run build` | **PASS** | Vite 7.3.7، 2555 module، 2.62s، 22 ملفًا. |
| فحص الأسرار في البناء | سكربت قراءة فقط | **0** | لا قيم خدمة/تليجرام داخل `build/`. |
| اختبار متصفح محلي | مسارات عامة و404 عند 320/390/1440px | **PASS** | لا أخطاء صفحات أو تجاوز أفقي؛ يلزم فحص Preview/Production منفصلًا. |
| تطابق CSP مع Supabase | مقارنة ref | **match=yes** | بدون طباعة القيم. |
| فحص الملفات المتعقبة | `git grep` لأنماط المفاتيح | **لا أنماط خطرة** | فقط placeholders. |

**خط الأساس قبل المعالجة:** `npm test` = 783 passed (8 مجموعات: 81+83+78+78+72+91+98+202)، والبناء PASS. الزيادة الحالية = 34 اختبارًا جديدًا (18 admin-products + 16 موزعة على rate limiting/tracking/logout/Phase 3).

**ما لم يُختبر:**

- E2E على الإنتاج أو staging.
- متصفح حقيقي (console/network/CSP/mobile).
- اختبار حمل أو DoS.
- استعلامات الإنتاج الفعلية (`pg_policies`, `pg_stat_user_indexes`, تعريف العرض).
- سيناريو حذف منتج مرتبط بطلب قديم على بيانات حقيقية.

---

## 7. المشاكل الحرجة (Critical)

**لا توجد ثغرة حرجة مؤكدة (No confirmed critical vulnerability) في حدود ما تم فحصه.**  
لا يوجد تجاوز مصادقة مؤكد، ولا تنفيذ أوامر، ولا تسريب `service_role`، ولا SQL injection واضح.  
لكن هناك **مخاطر نشر حرجة التعطيل** (وليست ثغرات) موضوعة في القسم 8، وأهمها تعيين علم Phase 3 قبل نشر الواجهة.

---

## 8. المشاكل العالية (High)

### H-01 — لوحة المنتجات تقرأ العرض العام: فقدان `tags` وإخفاء المنتجات غير النشطة

- **الموقع:** `src/pages/AdminApp.js:1108`, `:1266-1275`, `:1326-1327`; `src/store.js:221-238`; `supabase/products_public_view.sql:112-119`, `:157`; `api/admin/products.js:314-319`.
- **ماذا يحدث:** `ProductsPanel` يستخدم `useStore().products`، والـ store يقرأ `products_public`. العرض:
  - يفلتر `active IS TRUE` → المنتجات المعطلة لا تظهر في الإدارة.
  - لا يعيد `tags` → `openEdit` ينسخ المنتج بدون `tags`، و`handleSave` يرسل `tags: ''` → **يمسح الوسوم عند أي حفظ**.
  - لا يوجد `GET /api/admin/products` يعيد الصف الكامل.
- **لماذا يهم:** فقدان بيانات حقيقي، وتعطيل دورة «إخفاء/إظهار المنتج»، وتقارير مخزون ناقصة.
- **الإصلاح:** أضف `GET /api/admin/products` محميًا بـ`products.read` ويعيد الصفوف الكاملة بـ`service_role`، واجعل `ProductsPanel` و`Dashboard` يقرآن منه. مؤقتًا: لا ترسل `tags`/`active` إذا لم تكونا موجودتين في النموذج.
- **أثر الإنتاج:** عالي. **التصنيف: Confirmed.**

### H-02 — ترتيب Phase 3 قد يُعطّل المتجر إذا سُبق النشر

- **الموقع:** `supabase/products_public_view.sql:218-230`; `docs/security-production-checklist.md:35-55`.
- **ماذا يحدث:** Phase 3 يسحب صلاحيات الجدول الأساسي من `anon/authenticated`. الحزمة القديمة تقرأ `products` مباشرة. لو أُنشئ العلم قبل نشر الحزمة الجديدة، تتعطل قراءة المنتجات في المتجر.
- **الإصلاح:** التزم بالترتيب: Phase 1 → نشر الواجهة → التحقق من الشبكة → إنشاء العلم → Phase 3. لا تنشئ العلم يدويًا قبل ذلك.
- **أثر الإنتاج:** تعطل كامل للمتجر ( outage ) إن خالف الترتيب. **التصنيف: Confirmed (deployment risk).**

### H-03 — العرض owner-rights لا يرث فلاتر RLS الإضافية

- **الموقع:** `supabase/products_public_view.sql:73`, `:156-157`.
- **ماذا يحدث:** `security_invoker=false` يعني أن العرض يقرأ `products` بصلاحيات المالك، ولا يطبق RLS row policies. هو يطبق `active IS TRUE` فقط. أي policy إضافية على `products` (ملكية، tenant، إخفاء صفوف) لن تُطبق.
- **الإصلاح:** قبل Phase 3، افحص `pg_policies` على الإنتاج. إن وُجد predicate إضافي، انسخه حرفيًا إلى `WHERE` في العرض قبل سحب الصلاحيات.
- **أثر الإنتاج:** تسريب صفوف منتجات كانت RLS تخفيها. **التصنيف: Potential (يتطلب فحص إنتاج).**

### H-04 — rate limit غير مشترك بدون Upstash

- **الموقع:** `api/_lib.js:297-318`; `api/auth.js:78-79`; `api/orders.js:47`; `api/coupons/validate.js`.
- **ماذا يحدث:** عند غياب Upstash، الحد in-memory لكل نسخة Serverless. هذا يقلل فعالية منع تخمين كلمات المرور أو spam الطلبات.
- **الإصلاح:** اضبط Upstash (موصى به) أو استخدم مخزنًا دائمًا.
- **أثر الإنتاج:** هجوم موزع محتمل. **التصنيف: Confirmed / Accepted مؤقتًا.**

---

## 9. المشاكل المتوسطة والمنخفضة

| ID | الخطورة | الموقع | الملخص | الإصلاح | التصنيف |
|---|---|---|---|---|---|
| M-01 | متوسط | `api/auth.js:59-62`; `api/_lib.js:108` | تسجيل الخروج لا يُبطل التوكن (بدون رفع `session_version`). | أضف `logout-all` أو قصّر TTL. | Confirmed |
| M-02 | متوسط | `supabase/atomic_order_lifecycle.sql:34-43`; `api/admin/orders.js:174-184` | حذف طلب به منتج محذوف يمنع استعادة مخزون السطور الأخرى. | امنع حذف المنتج المرتبط، أو استعادة جزئية + تقرير. | Confirmed / Accepted |
| M-03 | متوسط | `api/_lib.js:612-627` | توكن التتبع بلا انتهاء، ويتأثر بتدوير `SESSION_SECRET`. | أضف `exp`/`version`. | Confirmed |
| M-04 | متوسط | `supabase/security_hardening.sql:95-101`; docs §3 | signup trigger قد ينشئ `support` بلا كلمة مرور. | أغلق signups أو راجع الـ trigger. | Potential / Manual |
| M-05 | متوسط | `src/store.js:219-245`; `src/pages/ShopPage.js:600` | فشل تحميل المنتجات يظهر كـ«لا توجد منتجات». | اعرض خطأ + retry. | Confirmed |
| M-06 | متوسط | `src/pages/AdminApp.js:392-404` | تقارير المخزون لا ترى المنتجات غير النشطة. | يُحل مع H-01. | Confirmed |
| M-07 | متوسط | `src/pages/TrackOrder.js:53-61`, `:108-135`; `api/orders.js:388-396` | إدخال رقم الطلب يدويًا لا يعمل بدون `tk`. | وضّح UX أو أضف تحققًا بديلًا. | Confirmed |
| M-08 | متوسط | `scripts/test-sql-concurrency.mjs:536-547`; لا `.github` | اختبارات SQL قد تُتخطى بصمت. | CI + `ZSHM_REQUIRE_SQL_TESTS=1`. | Confirmed |
| L-01 | منخفض | `src/pages/ShopPage.js:152-155` | «Best Seller» يفرز بـ`sales` غير الموجود. | استخدم `label` أو حقلًا محسوبًا. | Confirmed |
| L-02 | منخفض | `src/components/admin/ImageUploader.js:385` | `<img>` بدون `alt`. | أضف `alt`. | Confirmed |
| L-03 | منخفض | `src/pages/HomePage.js:15`; `src/pages/ShopPage.js:61`; `src/store.js:233` | فلاتر `active` ميتة بعد إزالة الحقل من العرض. | احذفها أو أعد الحقل بمعنى واضح. | No issue |
| L-04 | منخفض | `src/lib/security.js:114-121`; `src/lib/auth.js:129-138`; `api/_lib.js:446-455` | خرائط صلاحيات مكررة، إحداها غير مستخدمة وناقصة. | مصدر واحد. | Potential |
| L-05 | منخفض | `.env.example:2-6`; `vite.config.js:15-17` | `VITE_*` مقابل `REACT_APP_*`، و`UPSTASH_*` غير موثقة. | وحّد/وثّق. | Confirmed |
| L-06 | منخفض | `index.html:2` | `lang="en"` مع محتوى عربي/إنجليزي. | اضبط اللغة/الاتجاه. | Confirmed |
| L-07 | منخفض | `api/sitemap.mjs` | كان sitemap ثابتًا ولا يسرد المنتجات. | أُضيف توليد ديناميكي من `products_public`؛ يلزم تحقق Preview/Production بعد النشر. | Fixed locally |
| L-08 | منخفض | `vercel.json:31` | `img-src https:` واسع. | ضيّق المضيفين إن أمكن. | Accepted |
| L-09 | منخفض | `api/_lib.js:1028-1038` | `maskOrderForLimitedAccess` غير مستخدم. | احذف أو استخدم. | No issue |
| L-10 | منخفض | `api/orders.js:132`; `src/store.js:352-356` | `reservedStock` بلا كاتب/دورة حياة. | قرار SEC-24. | Open decision |

---

## 10. الحكم النهائي والخطوات المتبقية

### 10.1 الحكم

**Conditional Go — ليس Production-ready بالكامل بعد.**

- **المتجر يمكن أن يعمل** إذا كانت الواجهة الحالية تقرأ `products_public` وPhase 3 مطبّق بشكل صحيح.
- **لكن لا يصح إعلان الجاهزية النهائية** قبل إصلاح H-01 (لوحة المنتجات/`tags`)، وتثبيت ترتيب Phase 3 (H-02)، والتحقق من `pg_policies` (H-03)، وإغلاق البنود اليدوية.

### 10.2 المتبقي قبل إعلان الجاهزية — بالترتيب

**P0 — حاجز (Blocking):**

1. **أصلح H-01:** أضف `GET /api/admin/products` (service role + `products.read`) واجعل لوحة المنتجات والـ Dashboard تقرأ منه؛ لا ترسل `tags`/`active` من نموذج ناقص.
2. **ثبّت ترتيب Phase 3:** لا تنشئ `products_public_frontend_live` قبل نشر الحزمة الجديدة والتحقق من شبكة المتجر.
3. **افحص `pg_policies` و`pg_get_viewdef` على الإنتاج**؛ انسخ أي predicate إضافي إلى العرض قبل Phase 3.
4. **تحقق من `active`:** عدد الصفوف `active IS TRUE` ليس صفرًا، وأن المنتجات المعطلة فعلًا هي فقط غير النشطة.
5. **تحقق من حالة Phase 3 على الإنتاج:** `anon/authenticated` لا يقرآن `products` (جدولًا وأعمدة)، و`anon` يقرأ `products_public`، و`service_role` يحتفظ بـDML.
6. **Storage:** إما أن يكون الملف طبّق السياسات، أو احذف سياسات `products` فقط من Dashboard وأعد التشغيل. لا تغيّر الملكية/تعطّل RLS.

**P1 — قبل/مع الإطلاق:**

7. اضبط Upstash (أو اقبل مخاطرة rate limit الموزع) — H-04.
8. نفّذ إعدادات Supabase Auth (إغلاق signups، MFA، URL، كلمة المرور) — M-04.
9. أضف إبطال الجلسة عند logout (M-01).
10. أضف انتهاء/نسخة لتوكن التتبع (M-03).
11. أضف CI يشغّل PostgreSQL مع `ZSHM_REQUIRE_SQL_TESTS=1` (M-08).
12. صحّح `.env.example` ووثّق `UPSTASH_*` (L-05).

**P2 — بعد الإطلاق:**

13. اجمع `pg_stat_user_indexes` قبل أي حذف index.
14. أصلح «Best Seller» وUX التتبع و`alt` وحالات الخطأ في المتجر (F-02/F-03/F-04/F-05).
15. وحّد خرائط الصلاحيات (L-04) واحذف الكود الميت.
16. تحقق من sitemap الديناميكي في Preview/Production واضبط `PUBLIC_BASE_URL` عند استخدام نطاق مخصص؛ وراجع اللغة السائدة (L-06/L-07).
17. احسم SEC-24 (`reservedStock`) نهائيًا (O-12).
18. نفّذ اختبار متصفح/Lighthouse/حمل على staging أو Preview.

### 10.3 شرط التوقيع النهائي

لا يُوقّع «Production-ready» إلا بعد:

- نجاح `npm test` و`npm run build` بعد إصلاح H-01.
- إثبات Phase 3 على الإنتاج بالاستعلامات المذكورة.
- نجاح سيناريو شراء كامل + إلغاء طلب + استعادة مخزون + تتبع + إدارة منتجات (بما فيها `tags` والمنتج غير النشط).
- عدم وجود أخطاء CSP/Console حرجة على Preview/Production.
- التأكد أن المستخدمين الحاليين (2) وأدوارهم لم يتغيروا.

---

### 10.4 تحديث بعد المعالجة المحلية

- **عُولجت محليًا واختُبرت:** H-01، M-01، M-03، M-05، M-06، M-07، M-08، F-02…F-07، F-10، L-01، L-02، L-04، L-05، إضافة إلى تقوية S-02/S-03/S-10/S-11/S-16/S-17.
- **أُعِدّت لكنها تحتاج تنفيذًا إنتاجيًا يدويًا:** H-02، H-03/S-13، S-12/M-04، H-04/S-10، Phase 3 وكل ملفات SQL في `supabase/`.
- **بقيت مفتوحة/مقبولة:** O-11/M-02، O-12/L-10، O-14، S-01، S-05، S-18/L-08، F-06/L-03، F-08/L-06، صفحات المنتجات الديناميكية في F-09/L-07، S-20/L-09.
- **محجوب إنتاجيًا:** فحص Preview/Production لـF-13 وأي استعلام على قاعدة الإنتاج.

التفاصيل الكاملة والملفات والأوامر في **§11** وفي `docs/production-remediation-handoff.md`.

---

## 11. مصفوفة حالة ما بعد المعالجة (لكل معرّف)

> **مهم:** كل ما هو «FIXED LOCALLY AND TESTED» يعني: التعديل موجود في شجرة العمل **غير المُنشورة** فوق `a0e78f4`، ونجحت الاختبارات المحلية. لا يعني أن الإنتاج تغيّر. أي بند SQL يبقى «مُعدًّا» حتى يُنفَّذ يدويًا.

**دلالة الحالات:**

| الحالة | المعنى |
|---|---|
| **FIXED LOCALLY AND TESTED** | عُولج في الكود/الاختبارات محليًا، والاختبارات والبناء ناجحان. يلزمه نشر عادي فقط. |
| **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | الملف/الخطوات جاهزة ومُراجعة، لكن التنفيذ على الإنتاج أو Dashboard لم يُنفَّذ. |
| **BLOCKED** | لا يمكن إصلاحه أو إثباته من المستودع؛ يحتاج وصولًا للإنتاج/متصفحًا/قرارًا. |
| **ACCEPTED RISK / NO CHANGE** | فُحص، والقرار المتعمّد هو عدم التغيير (مع توثيق السبب). |

### 11.1 الأمان (S-01…S-20)

| ID | الحالة | ما تم / الدليل | المتبقي يدويًا |
|---|---|---|---|
| S-01 | **ACCEPTED RISK / NO CHANGE** | أُبقي `security_invoker=false` + `security_barrier=true`؛ التغيير إلى invoker يعيد كشف `reservedStock`. موثّق في §2.2 والـ checklist. | لا شيء (قرار). |
| S-02 | **FIXED LOCALLY AND TESTED** | Phase 3 يسحب ACL الجدول **والأعمدة** من `PUBLIC/anon/authenticated`، ويتحقق عبر `has_table_privilege` + فحص أعمدة. اختبار SQL 202/202. | تنفيذ Phase 3 بعد النشر (§11.9). |
| S-03 | **FIXED LOCALLY AND TESTED** | قائمة أعمدة صريحة، `reservedStock` غائب، والميجريشن يرفض إضافته، وPhase 1 يسجّل `products_public_phase1_applied`. المتجر يقرأ العرض. | تطبيق الملف في الإنتاج. |
| S-04 | **ACCEPTED RISK / NO CHANGE** | `service_role` لا يُمس؛ اختبار SQL يثبت بقاء DML. | لا شيء. |
| S-05 | **ACCEPTED RISK / NO CHANGE** | RLS deny-all مقصود لـ`coupons/orders/users/zshm_deploy_flags/zshm_storage_policy_backup`. أُضيف تنبيه في ميجريشن العرض لمراجعة السياسات بدل إسكاتها. | لا تضف policies. |
| S-06 | **ACCEPTED RISK / NO CHANGE** | كوكي HttpOnly/Secure/SameSite=Strict + CSRF double-submit + Origin check (فُحص، سليم). | لا شيء. |
| S-07 | **ACCEPTED RISK / NO CHANGE** | `session_version` يُرفع عند تغيير الدور/كلمة المرور و`requirePerm` يتحقق منه. | تطبيق `session_revocation.sql` إن لم يكن مطبقًا. |
| S-08 | **ACCEPTED RISK / NO CHANGE** | scrypt + ترقية تلقائية + dummy hash. | لا شيء. |
| S-09 | **FIXED LOCALLY AND TESTED** | `api/auth.js` يرفع `users.session_version` عند logout (إن وُجد العمود)، فتُبطَل كل جلسات المستخدم فورًا؛ وبدون العمود يبقى مسح الكوكيز. اختبارات 74/74 تشمل إعادة استخدام الكوكي → 401. | تطبيق `session_revocation.sql`. |
| S-10 / H-04 | **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | الـ limiter أصبح محدودًا (`RATE_BUCKET_MAX=10000`)، مع sweep، مهلة 1.5s/AbortSignal، كشف خطأ لكل أمر في Upstash، إصلاح TTL=-1، وتحذير مُقيّد. اختبارات 97/97. | ضبط `UPSTASH_REDIS_REST_URL/TOKEN` في Vercel (Production+Preview) وإعادة نشر. |
| S-11 / M-03 | **FIXED LOCALLY AND TESTED** | توكنات جديدة اختيارية `v1.<exp>.<sig>` عند ضبط `TRACKING_TOKEN_TTL_HOURS`، والروابط القديمة 32-hex تظل صالحة. اختبارات 106/106. | ضبط المتغير إن رُغب الانتهاء؛ تدوير `SESSION_SECRET` يُبطل كل الروابط. |
| S-12 / M-04 | **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | خطوات إغلاق signups/MFA/URL/password موثقة في checklist. لا يمكن تنفيذها من المستودع. | Supabase Dashboard → Authentication. |
| S-13 / H-03 | **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | أُضيف تنبيه في Phase 3 عند وجود RLS SELECT policies، وأُضيف `supabase/verify_production_security.sql` (قراءة فقط) لفحص `pg_policies` وتعريف العرض. | تنفيذ الاستعلام على الإنتاج قبل Phase 3. **BLOCKED محليًا** (لا وصول إنتاج). |
| S-14 | **ACCEPTED RISK / NO CHANGE** | رفع الصور يتحقق من magic bytes والحجم والمسار (سليم). | لا شيء. |
| S-15 | **ACCEPTED RISK / NO CHANGE** | CSP/HSTS/COOP/CORS (سليم). | لا شيء. |
| S-16 / L-05 | **FIXED LOCALLY AND TESTED** | `.env.example` يوثّق `VITE_*` كأسماء البناء، و`REACT_APP_*` كبديل قديم مدعوم، و`UPSTASH_*`، و`TRACKING_TOKEN_TTL_HOURS`. | لا شيء. |
| S-17 / M-08 | **FIXED LOCALLY AND TESTED** | `.github/workflows/ci.yml` يثبّت PostgreSQL tools، ويضبط `ZSHM_REQUIRE_SQL_TESTS=1`، ويشغّل `npm ci` + `npm test` + `npm run build`. | **تفعيله يتطلب commit/push** (لم يُنفَّذا). |
| S-18 / L-08 | **ACCEPTED RISK / NO CHANGE** | `img-src https:` واسع بسبب الصور الخارجية؛ لا ينفّذ Script. | تضييق اختياري لاحقًا. |
| S-19 | **ACCEPTED RISK / NO CHANGE** | لا أسرار في البناء أو الملفات المتعقبة. | لا شيء. |
| S-20 / L-09 | **ACCEPTED RISK / NO CHANGE** | `maskOrderForLimitedAccess` كود غير مستخدم؛ أُبقي لأنه موثّق لمسار مستقبلي، وحذفه ليس ضروريًا. | حذف اختياري لاحقًا. |

### 11.2 الطلبات والمخزون (O-01…O-14)

| ID | الحالة | ما تم / الدليل | المتبقي يدويًا |
|---|---|---|---|
| O-01…O-10 | **ACCEPTED RISK / NO CHANGE** | فُحصت سليمة: حساب السيرفر، `FOR UPDATE` المرتّب، idempotency، رفض غير النشط، lifecycle ذرّي، كوبون داخل المعاملة، استعادة المخزون، `atomic_adjust_stock`، تاريخ القاهرة، والتتبع بالتوكن. اختبارات SQL 202/202. | تطبيق ملفات SQL بالترتيب (§11.9). |
| O-11 / M-02 | **ACCEPTED RISK** | حذف طلب به منتج محذوف نهائيًا قد يمنع استعادة مخزون السطور الأخرى؛ الـ API يُرجع `warnings`/`stockRestored=false`. | قرار منتج/مخطط لاحقًا (منع حذف المنتج المرتبط أو استعادة جزئية). |
| O-12 / L-10 | **BLOCKED** | `reservedStock` بلا كاتب/دورة حياة (SEC-24). لم يُخترع أي كاتب، ولم يُحذف الحقل. | قرار مخطط صريح: إزالة الحقل من الحساب أو إضافة دورة حياة موثقة. |
| O-13 | **ACCEPTED RISK / NO CHANGE** | تحديث الحالة المتفائل مع rollback عبر `refreshOrders` سليم. | لا شيء. |
| O-14 | **ACCEPTED RISK** | كل من لديه `orders.read` (بما فيهم support) يرى PII؛ تصميم مقصود. | مراجعة سياسة الوصول/الاحتفاظ. |

### 11.3 الواجهة الأمامية (F-01…F-13)

| ID | الحالة | ما تم / الدليل | المتبقي يدويًا |
|---|---|---|---|
| F-01 / H-01 | **FIXED LOCALLY AND TESTED** | أُضيف `GET /api/admin/products` (`products.read`، service role، صفوف كاملة، ترتيب `id desc`، أخطاء عامة). `store.js` يضيف `adminProducts`/`refreshAdminProducts` وتطبيعًا مشتركًا. `ProductsPanel` و`Dashboard` يقرآن منه؛ `tags` تُحمَل وتُحفَظ، والمنتج غير النشط يظهر بشارة `INACTIVE`، مع loading/error/retry. اختبار جديد 18/18. | نشر الواجهة + اختبار يدوي: منتج معطّل يظهر، والحفظ يحافظ على `tags`. |
| F-02 / M-05 | **FIXED LOCALLY AND TESTED** | ShopPage وHomePage يعرضان شريط خطأ + Retry عند `productsLoadStatus==='error'`، ولا يعرضان «لا توجد منتجات» مكان فشل التحميل. | تحقق بصري بعد النشر. |
| F-03 / L-01 | **FIXED LOCALLY AND TESTED** | «Best Seller» يفرز حسب `label` (لأن `sales` غير موجود في العرض)، مع الحفاظ على ترتيب المتعادلات. | لا شيء. |
| F-04 / M-07 | **FIXED LOCALLY AND TESTED** | TrackOrder يوضّح أن البحث يتطلب الرابط الآمن مع `tk`، والـ placeholder لم يعد يوحي بإدخال رقم فقط. لم يُضف مسار «رقم + هاتف» لأنه قرار أمني/منتج. | تحقق UX بعد النشر. |
| F-05 / L-02 | **FIXED LOCALLY AND TESTED** | معاينة `ImageUploader` أصبحت `alt="Product image N"`. | لا شيء. |
| F-06 / L-03 | **ACCEPTED RISK / NO CHANGE** | التطبيع يعيد `active` افتراضيًا `true`، فالفلاتر الدفاعية تبقى صحيحة ولا تضر. | تنظيف اختياري لاحقًا. |
| F-07 / L-04 | **FIXED LOCALLY AND TESTED** | `PERMISSIONS` و`hasPermission` أصبحا مصدرًا واحدًا مُصدَّرًا من `src/lib/security.js` ويستخدمهما `auth.js`، مع `dashboard.read`. | لا شيء. |
| F-08 / L-06 | **ACCEPTED RISK** | `lang="en"` لم يُغيَّر لأن المحتوى مختلط عربي/إنجليزي والقرار محتوى/SEO. | قرار لغة/اتجاه لاحقًا. |
| F-09 / L-07 | **FIXED LOCALLY; DEPLOYMENT CHECK PENDING** | `/sitemap.xml` يُعاد توجيهه إلى API ديناميكي يقرأ `products_public` بمفتاح anon فقط، ويستبعد غير المتاح ويزيل التكرار، مع `/` و`/shop` وfallback عند الفشل. اختبارات التوليد محلية. | تحقق بعد النشر واضبط `PUBLIC_BASE_URL` إذا اختلف النطاق. |
| F-10 / M-06 | **FIXED LOCALLY AND TESTED** | `Dashboard` يستخدم `adminProducts` (يشمل غير النشط) عند امتلاك `products.read`، مع fallback للمتجر لدور بلا صلاحية. | تحقق يدوي من تقرير المخزون. |
| F-11 / F-12 | **ACCEPTED RISK / NO CHANGE** | ProductCard/ErrorBoundary سليمان (فُحصا). | لا شيء. |
| F-13 | **PARTIALLY VERIFIED LOCALLY** | جرى اختبار مسارات المتجر و404 والاستجابة للمقاسات في متصفح محلي؛ لم يُختبر Preview/Production أو CSP/Network هناك. | اختبار Preview/Production يدويًا (§11.8 و§11.10). |

### 11.4 المشاكل العالية (H-01…H-04)

| ID | الحالة | الملخص |
|---|---|---|
| H-01 | **FIXED LOCALLY AND TESTED** | نفس F-01: مصدر إداري كامل عبر `GET /api/admin/products`، و`tags` لا تُمسح، والمنتجات غير النشطة مرئية. |
| H-02 | **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | ترتيب Phase 1 → نشر الواجهة → التحقق الشبكي → علم `products_public_frontend_live` → Phase 3. Phase 3 أصبح يرفض التنفيذ إذا غاب العرض/صلاحية anon/تطابق الصفوف/ظهور `reservedStock`، وكُتب علم `products_public_phase1_applied` تلقائيًا. |
| H-03 / S-13 | **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | استعلام `verify_production_security.sql` جاهز (SELECT فقط) لفحص `pg_policies` وتعريف العرض. لا يمكن تأكيده محليًا. |
| H-04 / S-10 | **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | الـ limiter قُوّي محليًا، لكن المشاركة الفعلية تحتاج ضبط Upstash في Vercel. |

### 11.5 المتوسطة والمنخفضة (M-01…M-08، L-01…L-10)

| ID | الحالة | الملاحظة |
|---|---|---|
| M-01 | **FIXED LOCALLY AND TESTED** | logout يرفع `session_version` (S-09). |
| M-02 | **ACCEPTED RISK** | O-11. |
| M-03 | **FIXED LOCALLY AND TESTED** | توكنات منتهية اختيارية مع توافق خلفي (S-11). |
| M-04 | **PREPARED — REQUIRES MANUAL PRODUCTION ACTION** | إعدادات Supabase Auth (S-12). |
| M-05 | **FIXED LOCALLY AND TESTED** | F-02. |
| M-06 | **FIXED LOCALLY AND TESTED** | F-10. |
| M-07 | **FIXED LOCALLY AND TESTED** | F-04. |
| M-08 | **FIXED LOCALLY AND TESTED** | CI جاهز؛ يتفعّل بعد commit/push (S-17). |
| L-01 | **FIXED LOCALLY AND TESTED** | F-03. |
| L-02 | **FIXED LOCALLY AND TESTED** | F-05. |
| L-03 | **ACCEPTED RISK / NO CHANGE** | F-06. |
| L-04 | **FIXED LOCALLY AND TESTED** | F-07. |
| L-05 | **FIXED LOCALLY AND TESTED** | S-16. |
| L-06 | **ACCEPTED RISK** | F-08. |
| L-07 | **PARTIALLY FIXED LOCALLY** | F-09؛ أُدرج `/shop`، وتبقى روابط المنتجات الديناميكية. |
| L-08 | **ACCEPTED RISK** | S-18. |
| L-09 | **ACCEPTED RISK / NO CHANGE** | S-20. |
| L-10 | **BLOCKED** | O-12 / SEC-24. |

### 11.6 الملفات المتغيرة في هذه المعالجة (كلها غير مُنشورة)

**كود التطبيق:** `api/admin/products.js`، `api/_lib.js`، `api/auth.js`، `src/store.js`، `src/pages/AdminApp.js`، `src/pages/ShopPage.js`، `src/pages/HomePage.js`، `src/pages/TrackOrder.js`، `src/components/admin/ImageUploader.js`، `src/lib/security.js`، `src/lib/auth.js`.

**SQL (مُعدّ، غير مُنفَّذ على الإنتاج):** `supabase/products_public_view.sql` (Phase 1 flag + حراسة Phase 3 + تنبيه RLS)، وملف جديد `supabase/verify_production_security.sql` (قراءة فقط).

**الإعداد/التوثيق/الاختبارات:** `.env.example`، `package.json`، `docs/security-production-checklist.md`، `.github/workflows/ci.yml` (جديد)، `scripts/test-admin-products.mjs` (جديد)، `scripts/test-sessions-admin.mjs`، `scripts/test-edge-transport.mjs`، `scripts/test-final-hardening.mjs`، `docs/production-remediation-handoff.md` (جديد).

### 11.7 SQL مُعدّ ولم يُنفَّذ (مقتطفات حرجة)

> لا تُنفّذ أيًا مما يلي الآن على الإنتاج. الترتيب الكامل في §5.2 و§11.9.

```sql
-- بعد نشر الواجهة الجديدة والتحقق من الشبكة فقط:
INSERT INTO public.zshm_deploy_flags (name, note)
VALUES ('products_public_frontend_live', 'new bundle deployed')
ON CONFLICT (name) DO NOTHING;
-- ثم أعد تشغيل supabase/products_public_view.sql لتنفيذ Phase 3.
```

```sql
-- فحص إنتاجي للقراءة فقط (لا يغيّر شيئًا):
-- نفّذ supabase/verify_production_security.sql كاملًا.
```

### 11.8 إجراءات Vercel / Dashboard لم تُنفَّذ

- Vercel: ضبط `UPSTASH_REDIS_REST_URL` و`UPSTASH_REDIS_REST_TOKEN` (Production + Preview)، و`TRACKING_TOKEN_TTL_HOURS` إن رُغب، ثم Redeploy.
- Vercel: التأكد من عدم وجود نسخة `VITE_`/`REACT_APP_` من أي مفتاح خدمة.
- Supabase Auth: إغلاق signups، تأكيد الإيميل، URL Configuration، MFA، سياسة كلمة المرور 12+، Leaked Password Protection.
- Supabase Storage: حدود bucket `products` (5MB، MIME المسموحة)، ومراجعة سياسات `products` فقط دون تغيير الملكية أو تعطيل RLS، ثم إعادة تشغيل `storage_hardening.sql`.
- لا تم تغيير أي مستخدم أو دور أو بيانات إنتاج.

### 11.9 ترتيب النشر والتراجع

**الترتيب الإلزامي:** preflight (قراءة فقط) → `atomic_place_order.sql` → `atomic_order_lifecycle.sql` → `admin_protection.sql` → `security_hardening.sql` → `coupons_lockdown.sql` (بعد نشر كود الكوبونات) → `session_revocation.sql` → `storage_hardening.sql` → `products_public_view.sql` **Phase 1** → **نشر الواجهة/الـ API الجديد** (يشمل `GET /api/admin/products`) → التحقق الشبكي → علم `products_public_frontend_live` → **Phase 3**.

**التراجع (Rollback):**
- الواجهة: Vercel → Deployments → Promote السابق. إن رجعت لحزمة تقرأ `products` مباشرة، أعد منح `SELECT` مؤقتًا للجدول (طوارئ فقط، يعيد كشف `reservedStock`) ثم عالجه فورًا؛ الأفضل إعادة نشر الحزمة الجديدة بدل منح الجدول.
- SQL: كل الملفات إضافية/idempotent؛ لا تحذف `users.session_version` (الكود يتعامل مع غيابه لكن الحذف يبطل الإبطال). `products_public` يمكن إبقاؤه؛ إعادة Phase 3 غير قابلة للعكس إلا بمنح صريح.
- Storage: استعادة السياسات من `public.zshm_storage_policy_backup` عبر `public.zshm_restore_storage_policies()`.
- Rate limit: إزالة متغيرات Upstash تعيد fallback لكل نسخة (وليس تعطيلًا كاملًا).
- تتبع: إزالة `TRACKING_TOKEN_TTL_HOURS` تعيد السلوك القديم؛ الروابط القديمة تبقى صالحة.

### 11.10 ما لا يمكن إصلاحه محليًا

1. إثبات `pg_policies`/تعريف العرض/صلاحيات `anon` الفعلية على الإنتاج.
2. `pg_stat_user_indexes` لاتخاذ قرار حذف الفهارس.
3. إعدادات Supabase Auth/Storage/Vercel.
4. اختبار متصفح حقيقي (console/network/CSP/mobile/E2E).
5. قرار `reservedStock` (SEC-24) وسياسة حذف المنتجات المرتبطة.
6. تفعيل CI (يتطلب commit/push، ولم يُنفَّذا).

---

**نهاية التقرير.**
