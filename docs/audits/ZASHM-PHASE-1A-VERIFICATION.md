# ZASHM — Phase 1A: Safe Verification & Remediation Preparation

**Date:** 22 November 2026  
**Mode:** inspection + preparation only. No application code, production data, environment, deployment, account, or package was changed.  
**Original audit:** not overwritten. This is a new report.  
**Original NO-GO decision:** **remains in force.**

---

## 1. Executive summary / الملخص التنفيذي

هذا التقرير هو نتيجة المرحلة 1A بعد موافقة المالك على أربع قرارات محددة: فحص منتجات الاختبار دون تعديلها، التحقق من تعارض أعداد الأدمن/الطلبات دون اتصال بالإنتاج، مراجعة سلوك الانقطاع دون تغييره، وإبقاء واتساب على الرئيسية فقط.

**الخلاصة:** لم يتم إصلاح أي عيب. تم توثيق الأدلة وتحضير خطط آمنة بانتظار قرار المالك.

| البند | الحالة | الخلاصة |
|---|---|---|
| C1 منتجات الاختبار | `CONFIRMED` محليًا / `NOT VERIFIED` إنتاجيًا | البناء المحلي يحتوي 5 قشور منتجات اختبار و manifest بخمسة IDs، بينما التوثيق يقول إن أربعة منها تعطّلت وإن anon يرى صفرًا. الموقع الحي أظهر سابقًا 5 منتجات و manifest بأربعة IDs. يلزم تحقق المالك من بيانات الإنتاج قبل أي تنظيف. |
| C4 الأدمن/الطلبات | `BLOCKED` + `OWNER ACTION REQUIRED` | التعارض (2 مقابل 3 أدمن، 8 مقابل 9 طلبات) مذكور في تقرير سابق فقط، وغير موجود كمستند في المستودع. لا يمكن حسمه بدون تشغيل المالك لسكربت تحقق للقراءة فقط. شرط الإيقاف في `AGENTS.md §7` مُفعّل. |
| C3 سلوك الانقطاع | `CONFIRMED` + `OWNER ACTION REQUIRED` | السيرفر بيرجّع `200 success:true pending:true` قبل الإرسال، ومفتاح idempotency بيتسحب من المتصفح فورًا. أوصي بـ `202` مع حفظ المفتاح، لكن لازم قرار صريح. |
| C2 تزامن حالة الطلب | `CONFIRMED` + `PROPOSED — NOT IMPLEMENTED` | الخلل حقيقي: السيرفر بيستخدم الحالة المقروءة حديثًا كشرط، فبيخلي 409 شبه مستحيل من الواجهة. الإصلاح المقترح صغير ومحصور، ومفيش تغيير SQL مطلوب. |
| واتساب | `CONFIRMED` | كود التطبيق مظبوط (الرئيسية فقط). مهارة التدقيق نفسها ما فيها أي ذكر متعارض، فما احتاجتش تعديل. التعارض موجود في مهارة `ui-ux-design` فقط، وخارج النطاق المسموح هنا. |

**قرار الذهاب للإنتاج:** **NO-GO** كما كان. وجود خطة أو تقرير لا يعني إصلاح المشكلة.

---

## 2. Initial and final Git status / حالة Git الابتدائية والنهائية

### Initial — قبل أي فحص

```text
=== git status --short ===
 M scripts/test-product-colors.mjs
 M src/index.css
 M src/lib/productColors.mjs
?? .opencode/skills/website-prelaunch-audit/

=== git diff --stat ===
 scripts/test-product-colors.mjs |  52 ++++++++++++--------
 src/index.css                   | 103 +++++++++++++++++++++++++++++-----------
 src/lib/productColors.mjs       |  38 ++++-----------
 3 files changed, 116 insertions(+), 77 deletions(-)

HEAD: 08c2d74 style: give every colour label the same bold lit treatment
docs/audits: did not exist
```

التعديلات الثلاثة والمجلد الخاص بالـ skill كلها **سابقة لهذه المهمة** وتم تركها كما هي بالضبط. لم أقم بـ commit، ولا stash، ولا reset، ولا revert، ولا discard.

### Final — بعد إنشاء هذا التقرير فقط

```text
 M scripts/test-product-colors.mjs
 M src/index.css
 M src/lib/productColors.mjs
?? .opencode/skills/website-prelaunch-audit/
?? docs/audits/
```

الفرق الوحيد هو ملف التقرير الجديد داخل `docs/audits/`. `git diff --stat` للتعديلات السابقة لم يتغير.

---

## 3. Owner decisions and how each was respected / قرارات المالك

| القرار | كيف تم احترامه |
|---|---|
| **Test products: `inspect`** | تم فحص الـ artifacts المحلية والسكربتات والتوثيق فقط. لم يتم حذف أو تعطيل أو إعادة تنشيط أو تعديل أي منتج، ولم يتم rebuild أو deploy. |
| **Admin accounts: `verify`** | تمت مراجعة التوثيق وسكربت التحقق محليًا فقط. لم يتم تشغيل SQL إنتاجي، ولا اتصال بقاعدة الإنتاج، ولا تعديل أي حساب. التقرير يحدد خطوات يدوية للمالك ولا يخمّن هوية الأدمن الثالث. |
| **Outage behavior: `review`** | تم تتبع المسار وتحليل خيارين دون تعديل. التوصية معروضة بانتظار موافقة صريحة؛ لم يتم اختيار الحل ضمنيًا. |
| **WhatsApp behavior: `home`** | لم يتم تعديل أي مكوّن أو route أو style أو رابط. تم فحص مهارة التدقيق فقط، وتبين أنها لا تحتوي تعارضًا، فلم يتم تعديل أي ملف توثيقي أيضًا. |

**إضافات السلامة:** لم يتم فتح `.env`، ولا طباعة أسرار أو كوكيز أو بيانات عملاء، ولا إرسال أي تنبيه خارجي، ولا تثبيت/تحديث/إزالة حزم، ولا أي عملية Vercel/Supabase تغيرية.

---

## 4. C1 — Product inspection findings / فحص منتجات الاختبار

### 4.1 مصفوفة الأدلة

| ID | عنوان القشرة المحلية | أين يظهر | الحالة وفق التوثيق | التصنيف |
|---|---|---|---|---|
| `1794943849613141` | `T-SHIRT — ZASHM` | `build/product/1794943849613141/index.html`؛ `build/prerendered-products.json:3`؛ live `/shop`; docs `security-production-checklist.md:47` | مُصنّف test data وتعطيله موثّق في 19 نوفمبر (`active=false`) | `CONFIRMED` محليًا / `NOT VERIFIED` إنتاجيًا |
| `1794955384475152` | `Pant — ZASHM` | `build/product/1794955384475152/index.html`؛ `build/prerendered-products.json:4`؛ live `/shop`; docs `:47` | مُصنّف test data ومعطّل موثّق | `CONFIRMED` محليًا / `NOT VERIFIED` إنتاجيًا |
| `1795094753892375` | `ففهلمام — ZASHM` | `build/product/1795094753892375/index.html`؛ `build/prerendered-products.json:5`؛ live `/shop`; docs `:47` | مُصنّف test data ومعطّل موثّق | `CONFIRMED` محليًا / `NOT VERIFIED` إنتاجيًا |
| `1795095084457224` | `Mohammed Hassan — ZASHM` | `build/product/1795095084457224/index.html`؛ `build/prerendered-products.json:6`؛ live `/shop`; docs `:48` | مُصنّف test data ومعطّل موثّق | `CONFIRMED` محليًا / `NOT VERIFIED` إنتاجيًا |
| `1795316290550696` | `My Products — ZASHM` | `build/product/1795316290550696/index.html`؛ `build/prerendered-products.json:7`؛ live `/shop` (ضمن الخمسة الظاهرة)؛ **غير مذكور** في قائمة التعطيل | غير موثّق؛ انفصال واضح بين البناء المحلي والتوثيق | `CONFIRMED` محليًا / `NOT VERIFIED` إنتاجيًا |

### 4.2 ما هو مؤكد محليًا

- `build/prerendered-products.json` يحتوي خمسة IDs، من ضمنهم الخمسة جدول أعلاه (`build/prerendered-products.json:1-9`).
- كل ID له قشرة HTML حقيقية داخل `build/product/<id>/index.html` بعنوان المنتج نفسه. أي أن هذه ليست مجرد قائمة قديمة؛ القشور اتكتبت فعلًا في آخر بناء محلي.
- `build/catalog-snapshot.json` و`public/catalog-snapshot.json` كلاهما `count: 0` و`generatedAt: 2026-11-10T00:29:30.020Z` (`build/catalog-snapshot.json:1-8`، `public/catalog-snapshot.json:1-8`). يعني ملف fallback فاضي عن قصد، وهو مش مصدر أسماء المنتجات دي.
- `package.json:18` بيشغّل `vite build && node scripts/prerender-products.mjs`، يعني الـ prerender بيحصل بعد كل build.
- `scripts/prerender-products.mjs:289-310` بيقرأ `products_public` بالanon key؛ `:318-325` بيفرّق بين "قراءة فاضية ناجحة" و"فشل قراءة"؛ `:336-354` بيكتب القشور والـ manifest فقط لو القراءة نجحت؛ `:443-448` ما بينشرش manifest عند الفشل.
- `vercel.json:2` build command بيعمل `resilience-sync.mjs --best-effort --stamp` قبل `npm run build`.
- `scripts/resilience-sync.mjs:462-470` بيبتلع فشل الـ snapshot في وضع `--best-effort`، و`:473-484` بيعمل نفس الشيء لمزامنة الصور. يعني **نعم**: `--best-effort` يسمح بbuild ناجح بكتالوج ناقص أو فاضي.
- `scripts/prerender-products.mjs:459-463` كمان بيبتلع أي prerender error عشان "build-safe" — فإن الـ build ممكن ينجح وهو مش قادر يقرأ الكتالوج.

### 4.3 ما هو مؤكد من التدقيق السابق (browser/live proof)

- `/shop` على النطاق المنشور عرض 5 منتجات، ومنها الأسماء والخصومات غير المهنية المذكورة أعلاه (EGP 300 / 1,900 و84% OFF).
- `/prerendered-products.json` المنشور كان فيه **4** IDs فقط، بينما المحلي فيه **5**.
- `/sitemap.xml` المنشور كان فيه 6 روابط.
- product ID الإضافي `1795316290550696` بيرجع `200` بعنوان عام `ZASHM — Luxury Fashion` وcanonical `/` وبدون Product JSON-LD.

### 4.4 ما هو متناقض في التوثيق

- `docs/security-production-checklist.md:46-52` بيقول صراحة إن anon `products_public` بيرجّع **0** ids وإن الأربعة IDs دول اتعطّلوا في 19 نوفمبر.
- نفس الملف `:72` بيقول إن `/prerendered-products.json` المنشور فيه `{"ids":[]}`، و`:73` بيقول إن sitemap فيه رابطين بس (الرئيسية + `/shop`).
- لكن `:53-57` بيسجّل `products 4` — يعني أربعة صفوف لسه موجودة (معطّلة منطقيًا)، مش محذوفة.
- التوثيق `:59-67` بيقول إن النطاق المنشور مبني من `b5543fc` بالهاش `index-CKR1oqUT.js`، بينما التدقيق السابق لقى هاش مختلف عن البناء المحلي. يعني **المنشور مش بالضرورة هو البناء الحالي**.

### 4.5 تحليل المصدر المحتمل (assumption, وليس حقيقة مؤكدة)

السيناريو الأرجح — دون ادعاء يقين — هو مزيج من اثنين:

1. **حالة بيانات الإنتاج نفسها:** إما أن التعطيل الموثّق لم يعد ساريًا، أو أن anon view بيرجّع صفوفًا active لسه. هذا هو التفسير الوحيد الذي يفسّر ظهور المنتجات في `/shop` نفسه، لأن الواجهة بتقرأ `products_public` مباشرة (لا تأتي من الـ manifest).
2. **انحراف النشر/البناء:** المنشور أقدم من التوثيق ومن البناء المحلي. هذا يفسّر لماذا الـ manifest المنشور 4 والمحلي 5، ولماذا الهاش مختلف.

الفرق بين 4 و5 IDs يرجّح أن `1795316290550696` أُضيف أو أُعيد تنشيطه في بيئة استخدمها البناء المحلي/المنشور الأحدث، وأنه خارج قائمة التعطيل الموثّقة.

### 4.6 الإجراء التصحيحي المقترح — `PROPOSED — NOT IMPLEMENTED`

**لا شيء منه يعمل الآن.** بعد موافقة المالك:

1. يحدّد المالك مصدر الحقيقة: الإنتاج أم بيئة بناء؟ ويقرر هل المنتجات دي test data فعلًا ولا بيانات حقيقية محتاج تحديث اسم/سعر.
2. يُشغَّل `supabase/verify_production_security.sql` (للقراءة فقط) ويُقارن `active_products` / `inactive_products` / `total_products` بالتوثيق. لا حذف ولا تعديل صفوف.
3. يُؤكَّد أي env استخدمها الـ build المنشور، ويُقارن هاش الحزمة المنشور بالهاش الموثّق.
4. بعد حسم البيانات فقط: rebuild من env مؤكد، ثم إعادة نشر بموافقة منفصلة، ثم إعادة فحص `/shop` و`/prerendered-products.json` و`sitemap.xml` والصفحة الإضافية.
5. تحديث `docs/security-production-checklist.md` و`docs/production-remediation-handoff.md` ليصبحا مصدرًا واحدًا متسقًا.

---

## 5. C4 — Admin/order discrepancy / تعارض الأدمن والطلبات

### 5.1 ما يمكن التحقق منه من المستودع — `CONFIRMED`

- `AGENTS.md:172-174` يعتبر "unexpected admin/user/order counts" **شرط إيقاف و reporting**. لم أحاول تجاوزه.
- `AGENTS.md:184-188` يوثّق أن هذه البيئة لا تملك Supabase Management token / DB connection، وأن Vercel CLI مسجّل للخروج. لذلك التحقق الإنتاجي هنا `BLOCKED`.
- `docs/security-production-checklist.md:53-57` يسجّل خط الأساس المُبلَّغ عنه: `orders 8`, `users 2`, `coupons 1`, `products 4`, و**حسابان** بدور `admin`.
- نفس الملف `:155-162` يكرّر أن المالك نفّذ استعلامات aggregate في Supabase SQL Editor في 20 نوفمبر، وأن الحسابين كلاهما `admin` بـ `session_version` مختلفين. الهويات مقصود عدم نسخها في المستند.
- `docs/production-remediation-handoff.md:164-173` يحيل إلى نفس سكربت التحقق ويضع الجدول المتوقع، بما في ذلك العدّ.
- `supabase/verify_production_security.sql:1-11` صريح: كل الجمل `SELECT`، لا يغيّر شيئًا، ولا يحتوي أسرارًا أو PII، وآمن للتكرار.
- السكربت `:111-118` بيحسب بالضبط: عدد الأدمن، عدد غير الأدمن، إجمالي المستخدمين، إجمالي الطلبات، وعدد الملغية.
- بحث مستقل في `docs/`, `AGENTS.md`, `supabase/`, `scripts/` **لم يجد أي ملف** يسجّل "3 admins" أو "9 orders". التعارض جاء من تقرير التدقيق السابق (DevOps inspector) وليس له أثر نصي في المستودع.

### 5.2 ما لا يمكن التحقق منه — `NOT VERIFIED` / `BLOCKED`

- لا أستطيع تأكيد أو نفي وجود أدمن ثالث.
- لا أستطيع تأكيد أو نفي أن عدد الطلبات 9 بدل 8.
- لا أستطيع معرفة توقيت أو سبب أي تغيير، لأنه لا يوجد سجل محلي بذلك.
- لن أخمّن هوية الحساب الإضافي. أي اسم أو بريد أو رقم طلب هنا سيكون تكهنًا ويُمنع.

**الحالة:** `BLOCKED` حتى ينفّذ المالك التحقق بنفسه. لا يعني هذا أن التقرير السابق خاطئ؛ يعني أنه غير قابل للتحقق من هنا.

### 5.3 إجراء يدوي آمن للمالك — `OWNER ACTION REQUIRED`

1. سجّل الدخول إلى Supabase dashboard للحساب الإنتاجي بحسابك الخاص.
2. افتح **SQL Editor** → استعلام جديد.
3. الصق محتوى `supabase/verify_production_security.sql` كاملًا وشغّله. لا تضف أي `INSERT/UPDATE/DELETE/ALTER`.
4. اقرأ فقط مخرجات القسم 6 (`supabase/verify_production_security.sql:100-122`)، وخصوصًا:
   - `admins` و`total_users` و`non_admins`
   - `total_orders` و`cancelled_orders`
   - `active_products` / `inactive_products` / `total_products`
   - `nonzero_reserved_stock` (يجب أن يكون 0)
5. قارن بالمتوقع الموثّق: `admins = 2`, `total_users = 2`, `total_orders = 8`, `coupons = 1`, `products = 4`, `nonzero_reserved_stock = 0`.
6. **لا تشارك أي عمود هوية أو بريد أو هاتف أو عنوان طلب.** أرسل الأرقام الإجمالية فقط.
7. إذا ظهر `admins = 3` أو `total_orders = 9` أو أي `reservedStock` غير صفري: **قف**. لا تحذف ولا تعطّل ولا تصلح؛ أبلغ بالأرقام فقط واترك قرار المعالجة لك.

### 5.4 الحالة النهائية لهذا البند

`STOP` بالنسبة لتحقيق C4. بقية بنود Phase 1A استُكملت لأنها لا تعتمد على معرفة هوية الأدمن الثالث. لا يجوز اعتبار NO-GO ملغيًا قبل حل هذا التعارض.

---

## 6. C3 — Outage behavior analysis / تحليل سلوك الانقطاع

### 6.1 المسار الحالي كما هو مؤكد في الكود — `CONFIRMED`

| الخطوة | الدليل |
|---|---|
| `acceptPending(reason)` يبني الطلب من بيانات العميل عند غياب البيانات الموثوقة | `api/orders.js:158-209` |
| يرسل الرد **أولًا** `200 { success:true, pending:true, order }` ثم يحاول إرسال تنبيه Telegram | `api/orders.js:215-231`، خصوصًا `:218-220` |
| عند فشل `product_lookup` يُستدعى `acceptPending` | `api/orders.js:244` (سياق `:233-274`) |
| عند فشل `coupon_lookup` يُستدعى `acceptPending` كمان | `api/orders.js:425-436` |
| `pricingAuthoritative` يظل `false` في هاتين الحالتين، فيُمرَّر `amountsFromClient: !pricingAuthoritative` | `api/orders.js:225` |
| فشل الإرسال نفسه يُبتلع بـ `safeLogError` بعد ما العميل استلم تأكيده | `api/orders.js:227-230` |
| القرار موثّق كـ owner decision 2026-11-10 | `docs/production-remediation-handoff.md:614-626` |
| الواجهة تعتبر أي `result.success` نجاحًا، وتحفظ التأكيد وتمسح مفتاح idempotency | `src/pages/CartPage.js:639-649`, `:705-712` |
| المتجر يضيف `pending=true` للطلب ويمنع إشعار التتبّع، لكنه يرجّع `success:true` | `src/store.js:806-834` |
| المفتاح يُنشأ مرتبطًا بتوقيع السلة ويُحذف عند أي نجاح | `src/lib/orderIdempotency.mjs:41-65`, `:68-77` |

**النتيجة العملية:** لو فشل الحفظ **و** فشل Telegram، يبقى العميل ومعه تأكيد `ZSH-…` غير قابل للتتبّع، والمالك ما وصله أي تنبيه، ومفتاح الـ idempotency اتمسح من المتصفح. أي محاولة لاحقة بنفس السلة تبدأ بمفتاح جديد.

### 6.2 الخيار 1 — `202 Accepted` + حفظ المفتاح — `PROPOSED — NOT IMPLEMENTED`

**Customer-visible behavior:** رسالة واضحة ثنائية اللغة: "استلمنا طلبك وسنتأكد منه قريبًا" بدل "تم تنفيذ طلبك". لا رابط تتبّع، لا مبلغ مؤكّد، لا وعد بالتسليم. يمكن عرض رقم مرجعي مؤقت مع وسم "تحت التأكيد".

**Unrecorded / duplicate order risk:** الأقل خطورة. لأن المفتاح يفضل محفوظًا حتى وصول قرار نهائي، إعادة المحاولة بعد تعافي قاعدة البيانات تستخدم نفس المفتاح؛ RPC الـ idempotency يمنع التكرار سواء كان الطلب قد حُفظ فعلًا أم لا. لكن يظل هناك خطر إذا تخلّى العميل عن المتصفح قبل التسوية — لازم معالجة يدوية من التنبيه.

**Pricing/trust:** ممتاز. لا يُعرض مبلغ العميل كسعر نهائي. التنبيه يظل يحمل `amountsFromClient` لكن بوسم واضح "للعرض فقط — غير محسوب سيرفريًا".

**Operational consequences:** محتاج تغيير في `api/orders.js`، `src/store.js`، `src/pages/CartPage.js`، و`src/lib/orderIdempotency.mjs`. فوق هذا محتاج runbook لتسوية الطلبات المعلّقة، وتنبيه عند فشل `sendPendingOrderAlert`. لو أردنا durable queue فده قرار بنية تحتية جديد ومش داخل النطاق الحالي.

**Tests required:**
- حقن فشل `product_lookup` → `202` + رسالة "will confirm shortly" + المفتاح لسه موجود.
- حقن فشل `coupon_lookup` → نفس النتيجة.
- حقن فشل `atomic_place_order` بـ `save_failed` → `202` لا `200 success`.
- فشل Telegram + فشل DB معًا → لا تأكيد نهائي، لا رابط تتبّع، حدث log منظّم.
- إعادة المحاولة بنفس المفتاح بعد تعافي DB → طلب واحد بالضبط؛ تكرار الطلب → `duplicate: true` بنفس الرقم.
- تأكيد إن stored order استخدم أسعار السيرفر دائمًا، حتى لو أرسل العميل `client.total` مزيفًا.
- إضافة `scripts/test-order-confirmation-session.mjs` إلى `npm test` (غير مضاف حاليًا).

**Monitoring required:** عدّاد للردود `202`، عدّاد لفشال التنبيهات، وتقرير يومي "pending confirmations بلا order row".

### 6.3 الخيار 2 — الإبقاء على السلوك الحالي + قبول المخاطرة — `CONFIRMED` كحالة حالية

**Customer-visible behavior:** كما اليوم — تأكيد عادي، لكن `pending` يخفي رابط التتبّع. العميل مش عارف إن الطلب غير موجود.

**Unrecorded / duplicate order risk:** مرتفع. المفتاح بيتسحب فورًا (`CartPage.js:705`)، فإعادة المحاولة بعد الانقطاع ممكن تنتج طلبًا ثانيًا لو الطلب الأول اتخزّن فعلًا قبل استجابة الفشل.

**Pricing/trust:** أضعف نقطة. العميل ممكن يشوف إجماليًا من حسابات المتصفح بينما السيرفر ما حسبش حاجة.

**Operational consequences:** لا تغيير كود، بس محتاج قبول كتابي + runbook: مراجعة كل تنبيهات "NOT stored" يدويًا، ومطابقتها بالطلبات، وتوثيق قصة خدمة عملاء جاهزة. لو Telegram فشل كمان فمفيش أثر يعتمد عليه.

**Tests required:** اختبار regression واحد يؤكد إن `pending` يمنع رابط التتبّع، واختبار يوثّق إن المفتاح اتمسح (حتى يفضل الخطر ظاهرًا مش مخفيًا).

### 6.4 التوصية — `PROPOSED — NOT IMPLEMENTED`

أوصي **بالخيار 1**. السبب مش تجميل: الخيار الحالي بيحوّل فشل بنية تحتية إلى وعد تجاري كاذب، وبيسحب أداة الوقاية الوحيدة (idempotency key) في نفس اللحظة. الخيار 1 بيحفظ الثقة ويخلي إعادة المحاولة آمنة.

**لكن:** ما حصلش أي تغيير. محتاج قرار صريح من المالك: "نفّذ الخيار 1" أو "اقبل الخيار 2 كتابةً مع الـ runbook". إلى حينها الوضع `OWNER ACTION REQUIRED`.

---

## 7. C2 — Stale-order lifecycle fix proposal / مقترح الإصلاح الآمن

### 7.1 وصف السباق — `CONFIRMED`

1. `src/store.js:838-839` تلاقي الطلب في Zustand وتقرأ `order.status` (مثلًا `Pending`).
2. `:842-845` تعمل تحديث متفائل وتضبط `status` الجديد محليًا.
3. `:848` بترسل `{ id, status }` فقط — **بدون** الحالة اللي شافتها الواجهة.
4. `api/admin/orders.js:184` يعيد قراءة الصف من DB بعد ذلك، ويأخذ `oldStatus` من القراءة الجديدة (`:188`).
5. `:198-202` يمرّر `oldStatus` كـ `p_expected_status`.
6. `supabase/atomic_order_lifecycle.sql:172-174` بيقول إن `p_expected_status` لازم يكون "الحالة اللي القارئ قرأها **قبل** القرار"، أي حالة واجهة الأدمن، مش الحالة بعد ما اتغيرت خلف الكواليس.

**الفشل:** أدمن بتاب قديم يضغط Confirmed على طلبٍ ملغي. السيرفر يقرأ `Cancelled` ويستخدمه كشرط، فيمرّ RPC، ويتعمل restore/خصم تاني. مسار `status_changed` → 409 في `api/admin/orders.js:213-214` شبه مستحيل الوصول من الواجهة.

### 7.2 لماذا الاختبار الحالي بيُثبّت الخطأ — `CONFIRMED`

`scripts/test-order-lifecycle.mjs:404-424` بيقول حرفيًا إن السيرفر "re-reads the row, so its expected status is now Shipped and the transition is legitimate" وبيتوقع `200` (`:415`). ده بيحوّل السلوك الغلط إلى مواصفة.

### 7.3 التغييرات المقترحة — `PROPOSED — NOT IMPLEMENTED`

**لا SQL migration مطلوبة.** الـ RPC نفسه سليم؛ المشكلة في الـ caller.

1. **`src/store.js`**
   - قبل الـ `set()` في `:842`، خزّن `const expectedStatus = order.status;`.
   - في `:848`، أرسل `{ id, status: newStatus, expectedStatus }`.
   - احتفظ بمنطق revert الحالي في `:849-853` — هو بالفعل بيعمل `refreshOrders()` عند أي خطأ، لذلك 409 هيرجّع الواجهة للحقيقة.

2. **`api/admin/orders.js`**
   - اقرأ `expectedStatus` من الـ body بعد `:176`.
   - لو موجود: تحقق إنه ضمن `ORDER_STATUSES`، واستخدمه كـ `p_expected_status`.
   - لو غير موجود: رجّع `oldStatus` كـ fallback عشان العملاء القدام ما ينكسرش.
   - خلّي الـ fresh read في `:184` مهمل للـ timestamps فقط (`parseOrderRow(order).timestamps`)، مش للشرط.
   - احتفظ برسالة 409 الحالية في `:213-214` وضيف رسالة واضحة بالعربية/الإنجليزية لو لزم.

3. **`scripts/test-order-lifecycle.mjs`**
   - عدّل تعليق `412-415` لأنه لم يعد صحيحًا كمواصفة.
   - أضف حالة اختبار handler-level:
     - `seed()`؛
     - `PATCH { id, status:'Shipped', expectedStatus:'Pending' }` → `200`؛
     - غيّر الصف خلف Handler إلى `Shipped`؛
     - `PATCH { id, status:'Cancelled', expectedStatus:'Pending' }` → `409` و`reason: status_changed`؛
     - تحقق إن المخزون والكوبون ما اتغيروش.
   - احتفظ بالاختبار المباشر للمستوى RPC في `:418-423`.
   - أضف اختبار توافق: PATCH بدون `expectedStatus` لسه بيشتغل بالقراءة الجديدة.
   - أضف اختبار رفض `expectedStatus` غير صالح → `422`.

### 7.4 مخاطر التوافق والتزامن — `CONFIRMED` كتحليل

- لو الواجهة اتنشرت قبل الـ API، الـ API سيتجاهل الحقل الجديد ولن يتحسن السلوك. لو الـ API اتنشر قبل الواجهة، القدام هيستمروا بالـ fallback. الأفضل نشر متزامن أو قبول فترة انتقالية قصيرة.
- أدمن بتاب قديم هياخد 409 أكتر بعد الإصلاح. ده سلوك صحيح بس محتاج رسالة "الطلب اتغير، جاري التحديث" بدل رسالة عامة.
- الـ optimistic update بيفضل موجود لحد ما الـ error بيخلّي `refreshOrders()` ترجّعه — ده موجود بالفعل.
- مفيش تغيير في توقيع `atomic_set_order_status`، فمفيش تأثير على RPCs تانية أو على `atomic_edit_order`.

---

## 8. WhatsApp documentation result / نتيجة فحص واتساب

- `AGENTS.md:9` (قاعدة الإجراءات العائمة في الملف المرجعي) والقرار المؤرخ 2026-11-19 بيقولوا: واتساب **في الرئيسية فقط**، scroll-to-top اتشال، وما يتضافش أي عائق جديد.
- `docs/security-production-checklist.md:87-88` بيؤكد إن الـ live sweep سجّل `WhatsApp home-only at z-index: 30000 with safe-area offsets, and no back-to-top action`.
- فحص `rg` على `.opencode/skills/website-prelaunch-audit/{SKILL.md,AUDIT-CHECKLIST.md,REPORT-TEMPLATE.md,PLAYWRIGHT.md}` لم يجد أي ذكر لـ WhatsApp / floating / always-visible / scroll-to-top. يعني **مفيش تعارض داخل مهارة التدقيق نفسه**، وبالتالي **ما عملتش أي تعديل توثيقي** — حتى المسموح منه ما كانش مطلوبًا.
- التعارض الحقيقي موجود في `.opencode/skills/ui-ux-design/SKILL.md:3` و`:59-71` و`:106`، حيث بيقول "always-visible WhatsApp/scroll-to-top actions" وإن الزرارين "must **always** be visible". ده `CONFIRMED` كـ documentation drift، بس **خارج النطاق المسموح في هذه المهمة**، فلم ألمسه.
- كود التطبيق لم يُمسّ. السلوك الحالي (home-only + unmount عند فتح السلة + z-index 30000 + safe-area) يظل كما هو.

**الحالة:** `OWNER ACTION REQUIRED` لتصحيح مهارة `ui-ux-design` في مهمة توثيقية منفصلة لاحقة، لو رغبت.

---

## 9. Evidence references / مراجع الأدلة

| المرجع | ما يثبته |
|---|---|
| `AGENTS.md:8-9` | منع commit/deploy/SQL/secrets بدون موافقة |
| `AGENTS.md:172-174` | شرط الإيقاف عند unexpected admin/user/order counts |
| `AGENTS.md:179-180` | عدم ادعاء تحقق لم يتم؛ فصل local/browser/production proof |
| `AGENTS.md:184-188` | غياب DB token وVercel CLI كـ blockers |
| `docs/security-production-checklist.md:44-57` | تعطيل 4 منتجات اختبار + خط الأساس 8/2/1/4 |
| `docs/security-production-checklist.md:59-83` | هاش المنشور، manifest فاضي، sitemap برابطين، noindex |
| `docs/security-production-checklist.md:87-88` | واتساب home-only، مفيش back-to-top |
| `docs/security-production-checklist.md:155-166` | تحقق المالك من العدّ في 20 نوفمبر |
| `docs/production-remediation-handoff.md:164-173` | الجدول المتوقع لنتائج التحقق |
| `docs/production-remediation-handoff.md:614-626` | قرار الانقطاع 2026-11-10 |
| `build/prerendered-products.json:1-9` | 5 IDs في البناء المحلي |
| `build/catalog-snapshot.json:1-8` / `public/catalog-snapshot.json:1-8` | snapshot فاضي بتاريخ 10 نوفمبر |
| `build/product/*/index.html` | 5 قشور بعناوين المنتجات الاختبارية |
| `vercel.json:2` | build command مع `--best-effort --stamp` |
| `package.json:18` | prerender جزء من build |
| `scripts/resilience-sync.mjs:462-484` | best-effort بيبتلع فشل الكتالوج والصور |
| `scripts/prerender-products.mjs:289-325`, `:336-354`, `:443-463` | قراءة `products_public`، fail-closed manifest، build-safe error swallowing |
| `api/sitemap.mjs:143-155` | sitemap بيعتمد على manifest وتوافر المخزون |
| `api/orders.js:158-231`, `:244`, `:425-436` | مسار pending وتوقيت الرد قبل التنبيه |
| `src/lib/orderIdempotency.mjs:41-77` | المفتاح مرتبط بتوقيع السلة ويُمسح |
| `src/pages/CartPage.js:631-649`, `:705-712` | إنشاء المفتاح، إرساله، ومسحه عند أي نجاح |
| `src/store.js:702-834` | إرسال مبالغ العميل للعرض فقط، و`pending` في النتيجة |
| `src/store.js:838-858` | تحديث حالة الطلب بدون `expectedStatus` |
| `api/admin/orders.js:175-214` | إعادة قراءة الحالة واستخدامها كشرط |
| `supabase/atomic_order_lifecycle.sql:171-174` | تعريف `p_expected_status` المطلوب |
| `scripts/test-order-lifecycle.mjs:404-424` | اختبار بيُثبّت السلوك الحالي |
| `supabase/verify_production_security.sql:1-11`, `:100-122` | سكربت للقراءة فقط + العدّ المطلوب |
| `.opencode/skills/website-prelaunch-audit/SKILL.md:22-37` | قواعد "لا تعديل بدون موافقة" و"افصل أنواع الدليل" |

---

## 10. Confirmed facts vs. unverified claims / مؤكد مقابل غير مؤكد

### `CONFIRMED`

- البناء المحلي فيه 5 منتجات اختبار و5 قشور وmanifest بخمسة IDs.
- `--best-effort` وbuild-safe prerender يسمحان بنجاح build بكتالوج ناقص.
- التوثيق بيقول إن 4 من دول اتعطّلوا وإن anon شايف صفر، وإن المنشور manifest فاضي.
- مسار الانقطاع بيرجّع `200 success:true` قبل التنبيه، ويمرّر مبالغ العميل عند غياب التسعير السيرفري.
- مفتاح idempotency اتمسح عند أي نجاح، بما فيها `pending`.
- `updateOrderStatus` ما بيرسلش `expectedStatus`، والـ API بيستخدم الحالة المقروءة حديثًا.
- مهارة التدقيق نفسها مفيهاش ذكر متعارض لواتساب.
- كل التعديلات السابقة في الـ working tree لسه موجودة ولم يُمسّ أي منها.

### `NOT VERIFIED`

- الحالة الفعلية لصفوف المنتجات في قاعدة الإنتاج الآن.
- هوية أو عدد الأدمن الحقيقي، وعدد الطلبات الحقيقي.
- أي env استخدمه النشر الحالي، وهل الهاش المنشور مطابق للموثّق ولا لا.
- ما إذا كان التنبيه قد وصل للمالك في أي حالة انقطاع سابقة.

### `OWNER ACTION REQUIRED`

- حسم حالة منتجات الاختبار وتحديد مصدر الحقيقة.
- تشغيل سكربت التحقق للقراءة فقط وإرسال الأرقام الإجمالية.
- اختيار الخيار 1 أو الخيار 2 لمسار الانقطاع.
- السماح بتنفيذ إصلاح C2 في مرحلة لاحقة.
- تصحيح مهارة `ui-ux-design` في مهمة منفصلة إن رغبت.

### `BLOCKED`

- كل تحقق إنتاجي: لا DB connection ولا Vercel CLI صالح هنا.
- إغلاق تعارض الأدمن/الطلبات (`AGENTS.md §7`).
- أي عملية نشر أو SQL أو تنظيف بيانات.

### `PROPOSED — NOT IMPLEMENTED`

- إعادة prerender/sitemap من env مؤكد بعد حسم البيانات.
- `202` + حفظ مفتاح idempotency + runbook.
- إرسال `expectedStatus` وتحديث اختبارات 409.
- تصحيح توثيق المهارة الأخرى.

---

## 11. Remaining blockers and owner decisions / العوائق المتبقية

| # | العائق | التصنيف | المطلوب من المالك |
|---|---|---|---|
| 1 | منتجات الاختبار ظاهرة على الموقع الحي رغم توثيق تعطيلها | `OWNER ACTION REQUIRED` | تأكيد هل هي test data، وتحديد مصدر الحقيقة، ثم إذن منفصل بأي rebuild/deploy |
| 2 | تعارض 2/3 أدمن و8/9 طلبات | `BLOCKED` | تشغيل `verify_production_security.sql` وإرسال aggregated counts فقط |
| 3 | مسار الانقطاع بيأكد طلب غير مخزّن | `OWNER ACTION REQUIRED` | اختيار `202` أو قبول المخاطرة كتابةً مع runbook |
| 4 | تزامن حالة الطلب | `PROPOSED — NOT IMPLEMENTED` | موافقة على تنفيذ الخيار المقترح في Phase 1B |
| 5 | غياب صلاحيات التحقق الإنتاجي | `BLOCKED` | توفير وصول مقيد للقراءة فقط أو تنفيذ المالك بنفسه |
| 6 | تعارض توثيق واتساب في مهارة `ui-ux-design` | `OWNER ACTION REQUIRED` | إذن بتصحيح توثيقي منفصل؛ الكود لا يُلمس |
| 7 | الهاش المنشور مختلف عن المحلي/الموثّق | `NOT VERIFIED` | إذن بمقارنة الهاش على النشر الجاري، دون نشر الآن |

---

## 12. Prioritized next-step plan / خارطة الخطوات التالية

### Gate 0 — قبل أي تعديل (إلزامي)
1. المالك يحسم C1: test data ولا بيانات حقيقية؟ وأي environment هو المصدر؟
2. المالك ينفّذ تحقق C4 ويُرسل الأرقام فقط. لو ظهر أدمن ثالث أو طلب زيادة، يظل `STOP`.
3. المالك يختار C3: تنفيذ `202` أم قبول الخيار 2 كتابةً.
4. يُعطى إذن صريح منفصل لتنفيذ C2.

### Phase 1B — بعد Gate 0 فقط
1. تنفيذ C2 (client + API + tests) ونشر متزامن، مع `ZSHM_REQUIRE_SQL_TESTS=1 npm test` و`npm run build` وتسجيل الهاش.
2. تنفيذ C3 حسب القرار، مع اختبارات حقن الفشل وتمكين `test-order-confirmation-session` في CI.
3. إصلاح P1 من التدقيق الأصلي: تتبّع الطلب بعد refresh، `noindex` على `/?track=`، Origin/Content-Type على نقاط POST العامة، focus trap، وtry/catch في AdminLogin.

### Phase 2 — تنظيف البيانات والنشر (بإذن منفصل)
1. تصحيح/تنظيف كتالوج الإنتاج **بعد** حسم C1 — لا حذف تلقائي.
2. rebuild من env مؤكد، ثم نشر، ثم تحقق حي من `/shop` وmanifest وsitemap والمنتج الإضافي.
3. توحيد مستندات الهجرة في مصدر واحد (Revision 10، `sizeRanges`، حالة التطبيق الفعلية).

### Phase 3 — تحسينات لاحقة
- pagination، تحقّق الكمية، تصحيح عدّاد اختبار الألوان، `toLowerCase()`، `REVOKE` دالة `zshm_valid_variant_stock`، تقوية CSP، ومراقبة 24 ساعة بعد أي نشر.

### بوابة الذهاب للإنتاج
تظل كما كانت في التدقيق الأصلي: كل P0 وP1 مغلقين + اختبارات وبناء على الشجرة النهائية + هاش منشور مطابق + فحص إنتاجي بإذن المالك + مراقبة 24 ساعة. **لم يتحقق أي شرط من دي في Phase 1A.**

---

## Completion statement / بيان الإنهاء

- **Initial git status:** مُثبّت في القسم 2. **Final git status:** مُثبّت في القسم 2.
- **File changed:** ملف واحد فقط هو هذا التقرير `docs/audits/ZASHM-PHASE-1A-VERIFICATION.md`. لم يتم تعديل مهارة التدقيق لأنها لا تحتوي تعارضًا. لم يتم تعديل أي ملف تطبيق أو SQL أو توثيق آخر.
- **Production data / accounts / orders / products / coupons / reviews / env / deployment:** لم يتغير أي منها. لم يُنفّذ أي SQL، ولا rebuild، ولا deploy، ولا Vercel operation، ولا تنبيه خارجي.
- **Packages:** لم يُثبّت أو يُحدَّث أو يُزَل أي package.
- **External service contacted:** لا. هذه المرحلة استخدمت قراءات محلية فقط. الأدلة الحية المذكورة مأخوذة من التدقيق السابق ومُوسومة كذلك، ولم يُعَد قياسها هنا.
- **Tests/build:** لم تُشغَّل في هذه المرحلة؛ لا يوجد ادعاء جديد بخصوصها. نتائج التدقيق السابق تظل كما هي.
- **NO-GO:** لا يزال ساريًا. وجود هذا التقرير أو المقترحات لا يُصلح أي Finding.
- أطلب موافقتك الصريحة قبل أي تنفيذ أو أي عملية إنتاجية.
